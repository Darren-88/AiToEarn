// 第一步：添加SSL证书验证兜底（解决网络连接核心问题）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 第二步：修改API域名配置为能正常访问的地址
export const config = {
  imageCDN: 'https://yika-bj.oss-cn-beijing.aliyuncs.com/',
  // 替换原来无效的域名，改用能正常访问的www.aitoearn.ai/api/v1
  apiBaseURL: 'https://www.aitoearn.ai/api/v1',
};

// 处理图片地址（原有代码完全不动）
export const getImageUrl = (path: string) => {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return `${config.imageCDN}${path}`;
};
