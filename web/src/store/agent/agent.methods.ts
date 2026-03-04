/**
 * Agent Store - 核心方法
 * 包含创建任务、继续任务、SSE处理等核心逻辑
 */

import type {
  IActionCard,
  IActionContext,
  IAgentState,
  ICreateTaskParams,
  IPendingTask,
  ISSEMessage,
  ITaskData,
} from './agent.types'
import type { ISSECallbacks, ISSEHandlerContext } from './handlers'
import type { MessageUtils } from './utils/message'
import type { IAgentRefs } from './utils/refs'
import type { WorkflowUtils } from './utils/workflow'
import { agentApi } from '@/api/agent'
import { toast } from '@/lib/toast'
import { useUserStore } from '@/store/user'
import { getInitialState } from './agent.state'
import { ActionRegistry, SSEHandlerRegistry } from './handlers'
import { buildPromptForAPI } from './utils/buildPrompt'
import { calculateProgress as calcProgress, getStatusConfig } from './utils/progress'

// ============ 方法工厂上下文 ============

export interface IMethodsContext {
  refs: IAgentRefs
  set: (partial: Partial<IAgentState> | ((state: IAgentState) => Partial<IAgentState>)) => void
  get: () => IAgentState
  workflowUtils: WorkflowUtils
  messageUtils: MessageUtils
  resetRefs: () => void
}

// ============ 创建 Store 方法 ============

export function createStoreMethods(ctx: IMethodsContext) {
  const { refs, set, get, workflowUtils, messageUtils, resetRefs } = ctx

  // 创建 SSE 处理器上下文
  const sseContext: ISSEHandlerContext = {
    refs,
    set: set as any,
    get,
    workflowUtils,
  }

  // ============ 内部方法（避免 this 问题） ============

  /** 计算进度 */
  function calculateProgress(status: string, isNewStatus: boolean): number {
    return calcProgress(get().progress, status, isNewStatus)
  }

  /** 处理任务结果 */
  function handleResult(resultMsg: any) {
    // 保存消费
    if (resultMsg.total_cost_usd !== undefined) {
      set({ currentCost: resultMsg.total_cost_usd })
    }

    // 从 result 中提取需要显示为卡片的 actions
    const actionCards: IActionCard[] = []
    // 需要显示卡片的 action 类型（这些不会自动执行，而是显示卡片让用户点击）
    const cardActionTypes = ['createChannel', 'updateChannel', 'loginChannel']
    // 需要自动执行的 action（如发布、保存草稿等）
    const autoExecuteActions: ITaskData[] = []
    // 收集所有 result 中的 medias（用于在消息中显示视频/图片）
    const allMedias: Array<{ type: string, url: string, thumbUrl?: string }> = []

    if (resultMsg.result) {
      const resultArray: ITaskData[] = Array.isArray(resultMsg.result) ? resultMsg.result : [resultMsg.result]

      resultArray.forEach((taskData) => {
        // 收集 medias（无论 action 类型）
        if (taskData.medias && Array.isArray(taskData.medias) && taskData.medias.length > 0) {
          taskData.medias.forEach((media: any) => {
            if (media && (media.url || media.thumbUrl)) {
              allMedias.push({
                type: media.type || 'IMAGE',
                url: media.url || '',
                thumbUrl: media.thumbUrl,
              })
            }
          })
        }

        if (taskData.action && cardActionTypes.includes(taskData.action)) {
          // 转换为 ActionCard 格式
          actionCards.push({
            type: taskData.action,
            platform: taskData.platform,
            accountId: taskData.accountId,
            title: taskData.title,
            description: taskData.description,
            medias: taskData.medias,
            tags: taskData.tags,
          })
        }
        else if (taskData.action && (taskData.action as string) !== 'none') {
          // 其他有效 action 自动执行（排除 none，none 是后端表示无操作的特殊值）
          autoExecuteActions.push(taskData)
        }
      })
    }

    // 显示结果消息
    if (resultMsg.message) {
      messageUtils.addMarkdownMessage(resultMsg.message)

      // 确保有 assistant 消息存在并更新内容
      const currentState = get()
      const currentAssistantId = refs.currentAssistantMessageId.value
      const hasAssistantMessage = currentState.messages.some(
        (m: any) => m.role === 'assistant' && m.id === currentAssistantId,
      )

      if (hasAssistantMessage && currentAssistantId) {
        // 如果 assistant 消息存在，更新其内容和 actions
        if (actionCards.length > 0) {
          messageUtils.updateMessageWithActions(resultMsg.message, actionCards)
        }
        else if (allMedias.length > 0) {
          // 有 medias 时使用带 medias 的更新方法
          messageUtils.updateMessageContentWithMedias(resultMsg.message, allMedias)
        }
        else {
          messageUtils.updateMessageContent(resultMsg.message)
        }
      }
      else {
        // 如果没有 assistant 消息，创建一个新的
        const assistantMessage = messageUtils.createAssistantMessage()
        assistantMessage.content = resultMsg.message
        assistantMessage.status = 'done'
        if (actionCards.length > 0) {
          assistantMessage.actions = actionCards
        }
        messageUtils.addMessage(assistantMessage)
        // 更新 refs 以便后续更新
        refs.currentAssistantMessageId.value = assistantMessage.id
      }
    }
    else if (actionCards.length > 0) {
      // 如果没有消息但有 action cards，也要更新
      messageUtils.updateMessageActions(actionCards)
    }

    set({
      progress: 100,
      isGenerating: false,
      workflowSteps: [],
    })

    // 处理需要自动执行的 actions
    if (autoExecuteActions.length > 0 && refs.actionContext.value) {
      console.log('[AgentStore] Processing auto-execute actions, count:', autoExecuteActions.length)
      ActionRegistry.executeBatch(autoExecuteActions, refs.actionContext.value)
    }

    // 刷新用户 Credits 余额
    // 使用 getState() 在非 React 组件中访问 store 方法
    try {
      const userStore = useUserStore.getState()
      if (userStore?.fetchCreditsBalance) {
        userStore.fetchCreditsBalance()
      }
    }
    catch (error) {
      console.warn('[AgentStore] Failed to refresh credits balance:', error)
    }
  }

  /** 处理 SSE 消息 */
  function handleSSEMessage(sseMessage: ISSEMessage, callbacks?: ISSECallbacks) {
    // 使用注册的处理器处理
    if (SSEHandlerRegistry.handle(sseMessage, sseContext, callbacks)) {
      // 处理 init 后刷新任务列表
      if (sseMessage.type === 'init' && sseMessage.taskId) {
        // 在回放调试模式下不触发后台刷新
        if (!get().debugReplayActive) {
          agentApi.getTaskList(1, 10).catch((err) => {
            console.warn('[AgentStore] Background refresh task list failed:', err)
          })
        }
      }
      return
    }

    // 处理 error 类型的 SSE，显示为 assistant 错误消息
    if (sseMessage.type === 'error') {
      let errText = ''
      try {
        if (typeof sseMessage.message === 'string') {
          errText = sseMessage.message
        }
        else if (sseMessage.message && typeof sseMessage.message === 'object') {
          errText = JSON.stringify(sseMessage.message)
        }
        else if (sseMessage.data) {
          errText = typeof sseMessage.data === 'string' ? sseMessage.data : JSON.stringify(sseMessage.data)
        }
        else {
          errText = `Error: ${sseMessage}`
        }
      }
      catch (e) {
        errText = 'Unknown error'
      }

      // 创建一个 assistant 消息，显示为错误卡片（不包含按钮）
      const assistantMessage = messageUtils.createAssistantMessage()
      assistantMessage.content = ''
      assistantMessage.status = 'done'
      assistantMessage.actions = [
        {
          type: 'errorOnly' as any,
          title: '生成失败',
          description: errText,
        },
      ]
      messageUtils.addMessage(assistantMessage)

      // 更新状态
      set({ isGenerating: false, progress: 0 })
      return
    }

    // 处理 result 消息（需要特殊处理）
    if (sseMessage.type === 'result' && sseMessage.message) {
      handleResult(sseMessage.message)
      return
    }

    // 处理 status 消息
    if (sseMessage.type === 'status' && sseMessage.status) {
      const newProgress = calculateProgress(sseMessage.status, true)
      set({ progress: newProgress })
    }
  }

  // ============ 返回 Store 方法 ============

  return {
    // ============ 基础 Getters ============

    /** 获取当前任务ID */
    getCurrentTaskId: () => get().currentTaskId,

    /** 检查是否为当前任务的实时模式 */
    isRealtimeMode: (taskId: string) => {
      const state = get()
      return state.currentTaskId === taskId && state.isGenerating
    },

    // ============ 进度计算 ============

    /** 计算进度 */
    calculateProgress,

    /** 获取状态配置 */
    getStatusConfig,

    // ============ 核心方法：创建任务 ============

    /**
     * 创建 AI 生成任务
     */
    async createTask(params: ICreateTaskParams): Promise<string | null> {
      const { prompt, medias = [], t, onTaskIdReady, onLoginRequired } = params

      if (!prompt.trim()) {
        return null
      }

      refs.t.value = t

      // 检查登录状态
      const currentToken = useUserStore.getState().token
      if (!currentToken) {
        onLoginRequired?.()
        return null
      }

      try {
        // 重置状态
        set({
          isGenerating: true,
          currentTaskId: '',
          progress: 0,
          streamingText: '',
          markdownMessages: [],
          workflowSteps: [],
          messages: [],
          currentCost: 0,
        })
        resetRefs()

        // 添加用户消息
        const userMessage = messageUtils.createUserMessage(prompt, medias)
        set({ messages: [userMessage] })
        messageUtils.addMarkdownMessage(`👤 ${prompt}`)

        // 构建 Claude Prompt 格式
        const apiPrompt = buildPromptForAPI(prompt, medias)

        console.log('[AgentStore] Creating new task with prompt:', apiPrompt)

        // 添加 AI 待回复消息
        const assistantMessage = messageUtils.createAssistantMessage()
        messageUtils.addMessage(assistantMessage)

        // 创建 SSE 回调
        const sseCallbacks: ISSECallbacks = { onTaskIdReady }

        // 创建任务（SSE）- 使用闭包引用 handleSSEMessage
        const abortFn = await agentApi.createTaskWithSSE(
          { prompt: apiPrompt, includePartialMessages: true },
          (sseMessage: ISSEMessage) => {
            console.log('[AgentStore] SSE Message:', sseMessage)
            handleSSEMessage(sseMessage, sseCallbacks)
          },
          (error) => {
            console.error('[AgentStore] SSE Error:', error)
            const errorMsg = refs.t.value
              ? `${refs.t.value('aiGeneration.createTaskFailed' as any)}: ${error.message || refs.t.value('aiGeneration.unknownError' as any)}`
              : `Create task failed: ${error.message}`
            toast.error(errorMsg)
            set({ isGenerating: false, progress: 0 })
            messageUtils.markMessageError(error.message)
          },
          async () => {
            console.log('[AgentStore] SSE Done')
            set({ isGenerating: false, workflowSteps: [] })
            messageUtils.markMessageDone()
            refs.sseAbort.value = null
          },
        )

        refs.sseAbort.value = abortFn

        // 等待获取 taskId
        let waitTime = 0
        const maxWaitTime = 30000
        const checkInterval = 100

        while (!get().currentTaskId && waitTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, checkInterval))
          waitTime += checkInterval
        }

        return get().currentTaskId || null
      }
      catch (error: any) {
        console.error('[AgentStore] Create task error:', error)
        const errorMsg = refs.t.value
          ? `${refs.t.value('aiGeneration.createTaskFailed' as any)}: ${error.message || refs.t.value('aiGeneration.unknownError' as any)}`
          : `Create task failed: ${error.message}`
        toast.error(errorMsg)
        set({ isGenerating: false, progress: 0 })
        refs.sseAbort.value = null
        return null
      }
    },

    /**
     * 继续对话
     */
    async continueTask(params: ICreateTaskParams & { taskId: string }): Promise<void> {
      const { prompt, medias = [], t, taskId } = params

      if (!prompt.trim() || !taskId) {
        return
      }

      refs.t.value = t

      try {
        set({
          isGenerating: true,
          currentTaskId: taskId,
          progress: 10,
          workflowSteps: [],
        })
        resetRefs()

        // 添加用户消息
        const userMessage = messageUtils.createUserMessage(prompt, medias)
        set(state => ({
          messages: [...state.messages, userMessage],
        }))
        messageUtils.addMarkdownMessage(`👤 ${prompt}`)

        // 构建 Claude Prompt 格式
        const apiPrompt = buildPromptForAPI(prompt, medias)

        // 添加 AI 待回复消息
        const assistantMessage = messageUtils.createAssistantMessage()
        messageUtils.addMessage(assistantMessage)

        console.log('[AgentStore] Continuing task:', taskId)

        // 创建任务（SSE）- 使用闭包引用 handleSSEMessage
        const abortFn = await agentApi.createTaskWithSSE(
          { prompt: apiPrompt, taskId, includePartialMessages: true },
          (sseMessage: ISSEMessage) => {
            console.log('[AgentStore] SSE Message:', sseMessage)
            handleSSEMessage(sseMessage)
          },
          (error) => {
            console.error('[AgentStore] SSE Error:', error)
            toast.error(error.message || 'Generation failed')
            set({ isGenerating: false, progress: 0 })
            messageUtils.markMessageError(error.message)
          },
          async () => {
            console.log('[AgentStore] SSE Done')
            set({ isGenerating: false, workflowSteps: [] })
            messageUtils.markMessageDone()
            refs.sseAbort.value = null
          },
        )

        refs.sseAbort.value = abortFn
      }
      catch (error: any) {
        console.error('[AgentStore] Continue task error:', error)
        toast.error(error.message || 'Continue task failed')
        set({ isGenerating: false, progress: 0 })
        refs.sseAbort.value = null
      }
    },

    // ============ SSE 消息处理 ============

    /** 处理 SSE 消息（暴露给外部使用） */
    handleSSEMessage,

    /** 处理任务结果（暴露给外部使用） */
    handleResult,

    // ============ 工作流方法代理 ============

    saveCurrentStepToMessage: workflowUtils.saveCurrentStepToMessage.bind(workflowUtils),
    startNewStep: workflowUtils.startNewStep.bind(workflowUtils),
    addWorkflowStep: workflowUtils.addWorkflowStep.bind(workflowUtils),
    updateLastWorkflowStep: workflowUtils.updateLastWorkflowStep.bind(workflowUtils),

    // ============ 任务控制 ============

    /** 停止当前任务 */
    stopTask() {
      if (refs.sseAbort.value) {
        console.log('[AgentStore] Aborting SSE connection')
        refs.sseAbort.value()
        refs.sseAbort.value = null
      }

      set({
        isGenerating: false,
        progress: 0,
        workflowSteps: [],
      })

      messageUtils.markMessageDone()
      // 移除 toast 显示，改为由调用方处理
    },

    /** 重置状态 */
    reset() {
      if (refs.sseAbort.value) {
        refs.sseAbort.value()
        refs.sseAbort.value = null
      }
      resetRefs()
      refs.t.value = null
      refs.actionContext.value = null
      set(getInitialState())
    },

    // ============ 消息管理 ============

    setMessages: messageUtils.setMessages.bind(messageUtils),
    appendMessage: messageUtils.addMessage.bind(messageUtils),
    /**
     * 为回放创建一个 assistant 消息并设置 refs，返回该消息 id
     * 这会使用内部的 messageUtils.createAssistantMessage 来保证 refs.currentAssistantMessageId 被正确设置
     */
    startReplaySession() {
      const assistantMessage = messageUtils.createAssistantMessage()
      // 标记为流式中
      assistantMessage.status = 'streaming'
      messageUtils.addMessage(assistantMessage)
      set({ isGenerating: true })
      return assistantMessage.id
    },

    // ============ 模式管理 ============

    /** 初始化实时模式 */
    initRealtimeMode(taskId: string) {
      set({ currentTaskId: taskId })
    },

    // ============ 待处理任务管理 ============

    /** 设置待处理任务（从首页跳转时使用） */
    setPendingTask(task: IPendingTask) {
      set({ pendingTask: task })
    },

    /** 获取并清除待处理任务 */
    consumePendingTask(): IPendingTask | null {
      const task = get().pendingTask
      if (task) {
        set({ pendingTask: null })
      }
      return task
    },

    /** 清除待处理任务 */
    clearPendingTask() {
      set({ pendingTask: null })
    },

    // ============ Action 上下文管理 ============

    /** 设置 Action 上下文 */
    setActionContext(context: IActionContext) {
      refs.actionContext.value = context
    },

    /** 获取 Action 上下文 */
    getActionContext(): IActionContext | null {
      return refs.actionContext.value
    },

    /** 手动执行 Action */
    async executeAction(taskData: ITaskData, context?: IActionContext): Promise<boolean> {
      const ctx = context || refs.actionContext.value
      if (!ctx) {
        console.warn('[AgentStore] No action context available')
        return false
      }
      return ActionRegistry.execute(taskData, ctx)
    },

    /** 批量执行 Actions */
    async executeActions(taskDataList: ITaskData[], context?: IActionContext): Promise<void> {
      const ctx = context || refs.actionContext.value
      if (!ctx) {
        console.warn('[AgentStore] No action context available')
        return
      }
      return ActionRegistry.executeBatch(taskDataList, ctx)
    },
  }
}

export type AgentStoreMethods = ReturnType<typeof createStoreMethods>


