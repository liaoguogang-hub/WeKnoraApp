import type { CapacitorConfig } from '@capacitor/cli';

/**
 * WeKnora 客户端 Capacitor 配置
 * 借鉴 leoliao-app V36.2，关键点：
 *  - androidScheme: 'http'  —— 页面用 http://localhost，避免「https 页面加载 http 后端」被拦
 *  - cleartext / allowMixedContent：自托管 WeKnora 后端走 http
 *  - 不启用 CapacitorHttp：它会缓冲 fetch 响应，破坏 SSE 流式输出
 */
const config: CapacitorConfig = {
  appId: 'com.weknora.app',
  appName: 'WeKnora',
  webDir: 'dist',
  server: {
    // ⚠️ 关键：用 http 而不是 https，避免「https 页面加载 http 资源」被 WebView 拦截
    // （这解决了 Mixed Content 导致 API 请求异常的问题）
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  // 注意：不要启用 CapacitorHttp —— 它会拦截 fetch 并把响应整体缓冲，
  // 会破坏 /agent-chat 的 SSE 流式输出。混合内容问题已由 androidScheme:'http' 解决。
};

export default config;