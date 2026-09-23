/**
 * WeKnoraApp 主入口 v2
 *
 * 设计：
 *  - 顶部 topbar (菜单按钮 + Agent 选择器 + 标题)
 *  - 抽屉式左侧导航 (Sessions 列表)
 *  - 主内容区（Chat / Agents / KBs / Settings）
 *  - 弹窗式 Settings（在主内容区切换）
 *
 * 借鉴：ChatGPT iOS / LobeChat / Obsidian Mobile
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { App } from '@capacitor/app';
import './components/sidebar';
import './components/chat-page';
import './components/settings-page';
import './components/agents-page';
import './components/knowledge-page';
import './components/agent-selector';
import { isConfigured, createSession, loadSettings } from './lib/weknora-client';
import { bindAgent } from './lib/session-agent';
import { loadTheme, applyTheme } from './lib/theme';

type Page = 'chat' | 'agents' | 'kb' | 'settings';

@customElement('ll-app')
export class LlApp extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  static UNUSED_styles = css`
    :host { display: block; height: 100vh; height: 100dvh; }
    .app-shell {
      display: flex; flex-direction: column;
      height: 100%;
      background: var(--bg);
      position: relative;
      overflow: hidden;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      padding: 10px var(--s-4);
      background: var(--overlay);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-bottom: 1px solid var(--border);
      z-index: 10;
      flex-shrink: 0;
      padding-top: max(10px, env(safe-area-inset-top));
    }
    .menu-btn {
      width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      background: transparent;
      border: none;
      color: var(--fg);
      font-size: 18px;
      border-radius: var(--r-md);
      cursor: pointer;
    }
    .menu-btn:hover { background: var(--bg-2); }
    .topbar-title {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
      flex: 1;
      text-align: center;
    }
    .topbar-actions { display: flex; gap: 4px; align-items: center; }
    .icon-btn {
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent;
      border: none;
      color: var(--fg-2);
      border-radius: var(--r-md);
      cursor: pointer;
      font-size: 18px;
      transition: background 0.15s var(--ease-quick);
    }
    .icon-btn:hover { background: var(--bg-2); color: var(--fg); }
    .main-content { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .drawer-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 50;
      animation: fadeIn 0.2s ease;
    }
    .drawer {
      position: fixed; top: 0; left: 0; bottom: 0;
      width: 86%; max-width: 320px;
      background: var(--overlay);
      backdrop-filter: blur(30px) saturate(180%);
      -webkit-backdrop-filter: blur(30px) saturate(180%);
      border-right: 1px solid var(--border);
      z-index: 51;
      display: flex; flex-direction: column;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      animation: slideInLeft 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideInLeft {
      from { transform: translateX(-100%); }
      to { transform: translateX(0); }
    }
    .welcome {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--s-6);
      text-align: center;
    }
    .welcome-card {
      max-width: 360px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: var(--s-7);
      box-shadow: var(--shadow);
    }
    .welcome h2 {
      margin: 0 0 var(--s-3);
      font-size: 22px;
      letter-spacing: -0.02em;
    }
    .welcome p {
      color: var(--fg-2);
      margin: 0 0 var(--s-5);
      line-height: 1.6;
    }
    .welcome-actions { display: flex; flex-direction: column; gap: var(--s-2); }
  `;

  @state() private drawerOpen = false;
  @state() private page: Page = 'chat';
  @state() private sessionId = '';
  @state() private configured = isConfigured();
  @state() private toast = '';
  private _creating = false;

  /** 抽屉是「返回键」打开的（而不是用户点 ☰ 打开的）—— 决定再次返回是关抽屉还是走退出 */
  private _drawerFromBack = false;
  /** 上次触发「再按一次退出」的时间，用于双击退出防误触 */
  private _lastBackAt = 0;
  private _toastTimer: any = null;
  private _backListener: { remove: () => void } | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.applyStoredTheme();
    window.addEventListener('storage', () => this.configured = isConfigured());
    // Settings 保存后：刷新配置状态；若已配置则回到 Chat
    this.addEventListener('settings-saved', () => {
      this.configured = isConfigured();
      if (this.configured) this.openPage('chat');
    });
    // 页面切换统一在 app 这一层接收。
    // ⚠️ 之前 @open-page 只挂在 <ll-sidebar> 上，于是从顶栏 Agent 选择器
    //    （ll-agent-selector，不在 sidebar 子树里）派发的 open-page
    //    冒泡到 ll-app 就没人接了 —— 那个「管理所有 Agent」点了没反应。
    //    挂在 ll-app 上能接住任何后代派发上来的 open-page。
    this.addEventListener('open-page', ((e: CustomEvent) => {
      const p = e.detail?.page as Page | undefined;
      if (p) this.openPage(p);
    }) as EventListener);
    // 「设置 → 连接」切换到了另一台 WeKnora：旧会话属于旧服务器，必须清掉，
    // 否则会拿着一台服务器的 sessionId 去请求另一台。
    this.addEventListener('connection-changed', () => {
      this.sessionId = '';
      localStorage.removeItem('weknora-last-session');
      this.configured = isConfigured();
      this.page = 'chat';
      this.drawerOpen = false;
      this._drawerFromBack = false;
      this.showToast('已切换连接');
      if (this.configured) void this.ensureSession();
    });
    // ✅ 恢复上次会话（不再每次启动都新建）
    if (this.configured) {
      this.restoreLastSession();
    }
    this.registerBackHandler();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._backListener?.remove();
    this._backListener = null;
    clearTimeout(this._toastTimer);
  }

  /**
   * 拦截 Android 系统返回（返回键 / 左滑返回手势）。
   *
   * ⚠️ 装了 @capacitor/app 之后，它的 OnBackPressedCallback 会**始终吞掉**返回事件，
   *    没注册监听的话只是 webView.goBack()（单页应用里等于没反应），
   *    所以退出必须显式调 App.exitApp()。
   *
   * 层级（避免「Chat 页开抽屉、抽屉又被返回关掉」的死循环）：
   *   ① 非 Chat 页          → 回 Chat
   *   ② 抽屉是手动打开的      → 关抽屉
   *   ③ Chat 页、抽屉关着     → 打开抽屉（并记下来源=返回键）
   *   ④ 抽屉是返回键打开的     → 进入退出流程（双击防误触）
   */
  private registerBackHandler() {
    App.addListener('backButton', () => this.handleBackButton())
      .then((h) => { this._backListener = h; })
      .catch((e) => console.warn('[app] backButton listener failed:', e));
  }

  private handleBackButton() {
    // ① 非 Chat 页 → 回 Chat
    if (this.page !== 'chat') {
      this.openPage('chat');
      return;
    }
    // 未配置时抽屉里没有内容可看，直接走退出流程
    if (!this.configured) {
      this.confirmExit();
      return;
    }
    // ② / ④ 抽屉开着
    if (this.drawerOpen) {
      if (this._drawerFromBack) {
        this.confirmExit();   // 返回键打开的抽屉 → 再返回即「退出」那一步
      } else {
        this.closeDrawer();   // 用户点 ☰ 打开的 → 先关掉
      }
      return;
    }
    // ③ Chat 页、抽屉关着 → 打开抽屉
    this.drawerOpen = true;
    this._drawerFromBack = true;
  }

  /** 退出前防误触：2 秒内再按一次才真的退出 */
  private confirmExit() {
    const now = Date.now();
    if (now - this._lastBackAt < 2000) {
      this._lastBackAt = 0;
      App.exitApp().catch((e) => console.warn('[app] exitApp failed:', e));
      return;
    }
    this._lastBackAt = now;
    this.showToast('再按一次返回键退出应用');
  }

  private showToast(msg: string) {
    this.toast = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast = ''; }, 2000);
  }

  /** 恢复上次打开的会话 */
  private async restoreLastSession() {
    const last = localStorage.getItem('weknora-last-session');
    if (!last) return; // 从没进过会话 → 交给 ensureSession 建新的
    try {
      this.sessionId = last;
      console.log('[app] restored last session', last);
    } catch (e) {
      console.warn('[app] restore last session failed', e);
    }
  }

  /** 记住当前会话 */
  private rememberSession(id: string) {
    if (id) localStorage.setItem('weknora-last-session', id);
  }

  private applyStoredTheme() {
    const t = loadTheme();
    applyTheme(t);
  }

  private toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    // 用户手动开/关 → 不再算「返回键打开的」
    this._drawerFromBack = false;
  }

  private closeDrawer() {
    this.drawerOpen = false;
    this._drawerFromBack = false;
  }

  private openPage(p: Page) {
    this.page = p;
    // 从其它页返回 Chat 时，优先回到上次会话
    if (p === 'chat') {
      const last = localStorage.getItem('weknora-last-session');
      this.sessionId = last || '';
    } else {
      this.sessionId = '';
    }
    this.drawerOpen = false;
    this._drawerFromBack = false;
    if (p === 'chat' && this.configured && !this.sessionId) {
      this.ensureSession();
    }
  }

  /** 进入 Chat 页但没有会话时，自动建一个，避免空白 */
  private async ensureSession() {
    if (this.sessionId || this._creating) return;
    this._creating = true;
    try {
      const s = await createSession(null);
      if (s?.id && this.page === 'chat' && !this.sessionId) {
        // 新会话绑定当前默认 Agent —— 后端不保存这个绑定，只能记在本地
        bindAgent(s.id, loadSettings().defaultAgentId || '');
        this.sessionId = s.id;
        this.rememberSession(s.id);
      }
    } catch (e) {
      console.warn('[app] ensureSession failed:', e);
    } finally {
      this._creating = false;
    }
  }

  private handleOpenChat(e: CustomEvent) {
    this.sessionId = e.detail.sessionId;
    this.rememberSession(e.detail.sessionId);
    this.page = 'chat';
    this.drawerOpen = false;
    this._drawerFromBack = false;
  }

  /** 左上角返回：只打开会话抽屉，不销毁当前会话（消息保持可见） */
  private handleBackToSessions() {
    this.drawerOpen = true;
    // 语义上等同于「返回」→ 复用系统返回键的层级，避免出现两次返回行为不一致
    this._drawerFromBack = true;
  }

  /** 侧边栏「新会话」→ 建会话并进入 */
  private async handleNewChat() {
    try {
      const s = await createSession(null);
      if (s?.id) {
        bindAgent(s.id, loadSettings().defaultAgentId || '');
        this.handleOpenChat(new CustomEvent('open-chat', { detail: { sessionId: s.id } }));
      }
    } catch (e) {
      console.warn('[app] new chat failed:', e);
    }
  }

  private renderTopbar() {
    const title = this.sessionId ? '' : this.pageTitle();
    return html`
      <div class="topbar">
        <button class="menu-btn" @click=${() => this.toggleDrawer()}>☰</button>
        ${title ? html`<div class="topbar-title">${title}</div>` : html`<div class="topbar-title"></div>`}
        <div class="topbar-actions">
          ${this.page === 'chat' ? html`
            <ll-agent-selector .sessionId=${this.sessionId || ''}></ll-agent-selector>
          ` : nothing}
          ${!this.sessionId && this.page !== 'chat' ? html`
            <button class="icon-btn" @click=${() => this.openPage('chat')} title="返回 Chat">✕</button>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private pageTitle(): string {
    switch (this.page) {
      case 'chat': return '';
      case 'agents': return 'Agent 管理';
      case 'kb': return '知识库';
      case 'settings': return '设置';
    }
  }

  private renderDrawer() {
    if (!this.drawerOpen) return nothing;
    return html`
      <div class="drawer-overlay" @click=${() => this.closeDrawer()}></div>
      <div class="drawer">
        <ll-sidebar
          .open=${this.drawerOpen}
          @open-chat=${(e: CustomEvent) => this.handleOpenChat(e)}
        ></ll-sidebar>
      </div>
    `;
  }

  private renderContent() {
    if (this.sessionId) {
      return html`<ll-chat-page .sessionId=${this.sessionId} @back=${() => this.handleBackToSessions()}></ll-chat-page>`;
    }
    switch (this.page) {
      case 'chat':
        if (!this.configured) return this.renderWelcome();
        // 已有配置但还没会话 → 自动建一个中
        this.ensureSession();
        return html`
          <div class="empty" style="min-height: calc(100dvh - 180px);">
            <div class="loading-pulse"><span></span><span></span><span></span></div>
            <div style="font-size:13px;">正在准备新会话…</div>
          </div>
        `;
      case 'agents':
        return html`<ll-agents-page></ll-agents-page>`;
      case 'kb':
        return html`<ll-knowledge-page></ll-knowledge-page>`;
      case 'settings':
        return html`<ll-settings-page></ll-settings-page>`;
    }
  }

  private renderWelcome() {
    return html`
      <div class="welcome">
        <div class="welcome-card">
          <h2>👋 欢迎使用 WeKnora</h2>
          <p>配置 WeKnora 后端地址和 API Key 后即可开始对话。<br>支持 RAG 检索、Agent 推理、联网搜索。</p>
          <div class="welcome-actions">
            <button class="btn primary" @click=${() => this.openPage('settings')}>前往设置</button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="app-shell">
        ${this.renderTopbar()}
        <div class="main-content">${this.renderContent()}</div>
        ${this.renderDrawer()}
        ${this.toast ? html`<div class="toast">${this.toast}</div>` : nothing}
      </div>
    `;
  }
}