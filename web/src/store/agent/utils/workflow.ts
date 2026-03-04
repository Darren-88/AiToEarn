/**
 * Agent Store - 工作流工具
 * 管理 AI 工作流步骤（工具调用、结果等）
 *
 * 注意：内部方法调用使用闭包引用，避免 this 上下文丢失问题
 */

import type { IMessageStep, IWorkflowStep } from '../agent.types'
import type { IAgentRefs } from './refs'

/** 工作流工具上下文 */
export interface IWorkflowContext {
  refs: IAgentRefs
  set: (partial: any) => void
  get: () => any
}

/**
 * 创建工作流工具方法
 */
export function createWorkflowUtils(ctx: IWorkflowContext) {
  const { refs, set } = ctx

  // ============ 内部方法（避免 this 问题） ============

  /**
   * 保存当前步骤到消息中
   * 关键：正确处理 textDeltaHandler 创建的 `-live` 步骤，更新而非新增
   */
  function saveCurrentStepToMessage() {
    if (refs.currentStepIndex.value < 0 || !refs.streamingText.value.trim()) {
      return
    }

    const stepData: IMessageStep = {
      id: `step-${refs.currentStepIndex.value}-saved`,
      content: refs.streamingText.value,
      workflowSteps: [...refs.currentStepWorkflow.value],
      isActive: false,
      timestamp: Date.now(),
    }

    set((state: any) => ({
      messages: state.messages.map((m: any) => {
        if (m.id === refs.currentAssistantMessageId.value) {
          const steps = m.steps || []
          // 查找匹配的步骤：可能是 -live 步骤或相同 index 的步骤
          const liveStepId = `step-${refs.currentStepIndex.value}-live`
          const existingIndex = steps.findIndex(
            (s: IMessageStep) =>
              s.id === liveStepId // 匹配 textDeltaHandler 创建的 -live 步骤
              || s.id.startsWith(`step-${refs.currentStepIndex.value}-`), // 匹配相同 index 的步骤
          )
          if (existingIndex >= 0) {
            // 更新已有步骤（保留工作流步骤的合并）
            const existingStep = steps[existingIndex]
            steps[existingIndex] = {
              ...stepData,
              // 合并工作流步骤，避免丢失
              workflowSteps: (stepData.workflowSteps && stepData.workflowSteps.length > 0)
                ? stepData.workflowSteps
                : (existingStep.workflowSteps || []),
            }
          }
          else {
            steps.push(stepData)
          }
          return { ...m, steps: [...steps] }
        }
        return m
      }),
    }))
  }

  /**
   * 添加工作流步骤到当前步骤
   */
  function addWorkflowStep(step: IWorkflowStep) {
    refs.currentStepWorkflow.value.push(step)

    // 更新全局工作流步骤（用于UI显示）
    set((state: any) => ({
      workflowSteps: [...state.workflowSteps.map((s: IWorkflowStep) => ({ ...s, isActive: false })), step],
    }))

    // 实时更新消息中的当前步骤的工作流
    set((state: any) => ({
      messages: state.messages.map((m: any) => {
        if (m.id === refs.currentAssistantMessageId.value) {
          const steps = m.steps || []
          if (steps.length > 0) {
            const lastStep = steps[steps.length - 1]
            steps[steps.length - 1] = {
              ...lastStep,
              workflowSteps: [...(lastStep.workflowSteps || []), step],
            }
            return { ...m, steps: [...steps] }
          }
        }
        return m
      }),
    }))
  }

  /**
   * 开始新步骤
   */
  function startNewStep() {
    // 保存当前步骤（如果有内容）- 使用闭包引用
    if (refs.streamingText.value.trim()) {
      saveCurrentStepToMessage()
    }

    // 重置当前步骤状态
    refs.streamingText.value = ''
    refs.currentStepWorkflow.value = []
    refs.currentStepIndex.value++

    console.log('[Workflow] Started new step:', refs.currentStepIndex.value)
  }

  /**
   * 更新最后一个工作流步骤
   */
  function updateLastWorkflowStep(updater: (step: IWorkflowStep) => IWorkflowStep) {
    // 更新当前步骤的工作流
    if (refs.currentStepWorkflow.value.length > 0) {
      const lastIndex = refs.currentStepWorkflow.value.length - 1
      refs.currentStepWorkflow.value[lastIndex] = updater(refs.currentStepWorkflow.value[lastIndex])
    }

    // 更新全局工作流步骤
    set((state: any) => {
      const steps = [...state.workflowSteps]
      if (steps.length > 0) {
        steps[steps.length - 1] = updater(steps[steps.length - 1])
      }
      return { workflowSteps: steps }
    })

    // 更新消息中的工作流步骤
    set((state: any) => ({
      messages: state.messages.map((m: any) => {
        if (m.id === refs.currentAssistantMessageId.value) {
          const steps = m.steps || []
          if (steps.length > 0) {
            const lastStep = steps[steps.length - 1]
            if (lastStep.workflowSteps && lastStep.workflowSteps.length > 0) {
              const workflowSteps = [...lastStep.workflowSteps]
              workflowSteps[workflowSteps.length - 1] = updater(workflowSteps[workflowSteps.length - 1])
              steps[steps.length - 1] = { ...lastStep, workflowSteps }
              return { ...m, steps: [...steps] }
            }
          }
        }
        return m
      }),
    }))
  }

  /**
   * 处理工具调用完成
   */
  function handleToolCallComplete(toolName: string, toolInput: string) {
    // 更新当前步骤的工作流
    const stepIndex = refs.currentStepWorkflow.value.findIndex(
      s => s.type === 'tool_call' && s.toolName === toolName && s.isActive,
    )
    if (stepIndex >= 0) {
      refs.currentStepWorkflow.value[stepIndex] = {
        ...refs.currentStepWorkflow.value[stepIndex],
        content: toolInput,
        isActive: false,
      }
    }

    // 更新全局工作流步骤
    set((state: any) => {
      const steps = [...state.workflowSteps]
      const globalStepIndex = steps.findIndex(
        s => s.type === 'tool_call' && s.toolName === toolName && s.isActive,
      )
      if (globalStepIndex >= 0) {
        steps[globalStepIndex] = {
          ...steps[globalStepIndex],
          content: toolInput,
          isActive: false,
        }
      }
      return { workflowSteps: steps }
    })

    // 记录到 markdown 消息
    const displayName = toolName.replace(/^mcp__\w+__/, '')
    set((state: any) => ({
      markdownMessages: [
        ...state.markdownMessages,
        `🔧 **Tool Call**: \`${displayName}\`\n\`\`\`json\n${toolInput}\n\`\`\``,
      ],
    }))
  }

  /**
   * 处理工具结果
   */
  function handleToolResult(resultText: string) {
    // 找到最近的 tool_call 步骤
    const lastToolCall = [...refs.currentStepWorkflow.value].reverse().find(s => s.type === 'tool_call')
    const prevToolName = lastToolCall?.toolName || 'Tool'

    // 添加工具结果步骤 - 使用闭包引用
    const resultStep: IWorkflowStep = {
      id: `result-${Date.now()}`,
      type: 'tool_result',
      toolName: prevToolName,
      content: resultText,
      isActive: false,
      timestamp: Date.now(),
    }
    addWorkflowStep(resultStep)

    // 记录到 markdown 消息
    const displayResult = resultText.length > 500 ? `${resultText.substring(0, 500)}...` : resultText
    set((state: any) => ({
      markdownMessages: [...state.markdownMessages, `📋 **Tool Result**:\n\`\`\`\n${displayResult}\n\`\`\``],
    }))
  }

  // ============ 返回方法对象 ============

  return {
    saveCurrentStepToMessage,
    startNewStep,
    addWorkflowStep,
    updateLastWorkflowStep,
    handleToolCallComplete,
    handleToolResult,
  }
}

export type WorkflowUtils = ReturnType<typeof createWorkflowUtils>


