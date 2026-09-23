/**
 * 侧边栏 Sessions 抽屉
 * 借鉴 ChatGPT iOS / LobeChat 的左侧导航
 */

import { LitElement, html, css } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import {
  listSessions, createSession, deleteSession, pinSession, listAgents, loadSettings,
  type Session, type Agent,
} from '../lib/weknora-client';
import { bindAgent, unbindAgent, resolveAgentForSession } from '../lib/session-agent';

@customElement('ll-sidebar')
export class LlSidebar extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  static UNUSED_styles = css`
    :host { display: block; height: 100%; }
    .wrap {
      display: flex; flex-direction: column;
      height: 100%;
      padding: 0;
    }
    .search-row {
      padding: var(--s-3) var(--s-4) var(--s-2);
    }
    .search-row input {
      width: 100%;
      padding: 8px 12px;
      background: var(--bg-2);
      border: 1px solid transparent;
      border-radius: var(--r-full);
      font-size: 13px;
      outline: none;
      color: var(--fg);
      transition: all 0.15s var(--ease-quick);
    }
    .search-row input:focus {
      background: var(--card);
      border-color: var(--border);
    }
    .new-chat {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      margin: 0 var(--s-4) var(--s-3);
      padding: 10px var(--s-3);
      background: var(--accent);
      color: var(--accent-fg);
      border-radius: var(--r-md);
      font-weight: 500;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: background 0.15s var(--ease-quick);
    }
    .new-chat:hover { background: var(--accent-hover); }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-3);
      padding: var(--s-3) var(--s-4) var(--s-2);
    }
    .list {
      flex: 1;
      overflow-y: auto;
      padding: 0 var(--s-3) var(--s-3);
    }
    .session-item {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      padding: 10px var(--s-3);
      border-radius: var(--r-md);
      cursor: pointer;
      transition: background 0.12s;
      position: relative;
      margin-bottom: 2px;
    }
    .session-item:hover { background: var(--bg-2); }
    .session-item.active { background: var(--accent-soft); }
    .session-item.active::before {
      content: '';
      position: absolute;
      left: -8px; top: 25%; bottom: 25%;
      width: 3px;
      background: var(--accent);
      border-radius: 0 3px 3px 0;
    }
    .session-icon {
      width: 28px; height: 28px;
      border-radius: var(--r-md);
      background: var(--bg-3);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px;
      flex-shrink: 0;
    }
    .session-meta { flex: 1; min-width: 0; }
    .session-title {
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-sub {
      font-size: 11px;
      color: var(--fg-3);
      margin-top: 2px;
    }
    .session-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.12s;
    }
    .session-item:hover .session-actions { opacity: 1; }
    .session-action-btn {
      width: 24px; height: 24px;
      display: flex; align-items: center; justify-content: center;
      border-radius: var(--r-sm);
      background: transparent;
      border: none;
      color: var(--fg-3);
      font-size: 12px;
      cursor: pointer;
    }
    .session-action-btn:hover { background: var(--bg-3); color: var(--fg); }
    .session-action-btn.active { color: var(--accent); }
    .empty-state {
      padding: var(--s-6) var(--s-4);
      text-align: center;
      color: var(--fg-3);
      font-size: 13px;
    }
    .error {
      margin: var(--s-3);
      padding: var(--s-3);
      background: var(--bg-2);
      color: var(--error);
      font-size: 13px;
      border-radius: var(--r-md);
    }
    .footer {
      padding: var(--s-3) var(--s-4);
      border-top: 1px solid var(--border);
    }
    .footer-btn {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      padding: 8px var(--s-3);
      width: 100%;
      background: transparent;
      border: none;
      border-radius: var(--r-md);
      color: var(--fg);
      cursor: pointer;
      font-size: 14px;
      transition: background 0.12s;
    }
    .footer-btn:hover { background: var(--bg-2); }
  `;

  @property({ type: Boolean, reflect: true }) open = false;
  @state() private sessions: Session[] = [];
  @state() private keyword = '';
  @state() private activeId = '';
  @state() private loading = false;
  @state() private error = '';
  /** 只用于在会话列表里显示「这个会话用的是哪个 agent」 */
  @state() private agents: Agent[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
    void this.loadAgents();
  }

  private async loadAgents() {
    try {
      this.agents = await listAgents();
    } catch {
      // 拿不到 agent 列表就只是不显示名字，不影响会话列表本身
    }
  }

  private agentNameOf(sessionId: string): string {
    const id = resolveAgentForSession(sessionId, loadSettings().defaultAgentId || '');
    return this.agents.find((a) => a.id === id)?.name || '';
  }

  private async refresh() {
    this.loading = true;
    this.error = '';
    try {
      this.sessions = await listSessions({ keyword: this.keyword || undefined });
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private handleSearchInput(ev: Event) {
    this.keyword = (ev.target as HTMLInputElement).value;
    clearTimeout((this as any)._searchT);
    (this as any)._searchT = setTimeout(() => this.refresh(), 300);
  }

  private async handleNew() {
    try {
      const s = await createSession(null);
      // 新会话 = 新的 agent 载体，把当前默认 Agent 绑到它身上
      bindAgent(s.id, loadSettings().defaultAgentId || '');
      this.activeId = s.id;
      this.sessions = [s, ...this.sessions];
      this.dispatchEvent(new CustomEvent('open-chat', { detail: { sessionId: s.id } }));
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private handleOpen(s: Session) {
    this.activeId = s.id;
    this.dispatchEvent(new CustomEvent('open-chat', { detail: { sessionId: s.id } }));
    this.dispatchEvent(new CustomEvent('close-drawer', { bubbles: true, composed: true }));
  }

  private async handleDelete(s: Session, ev: Event) {
    ev.stopPropagation();
    if (!confirm('删除会话？')) return;
    try {
      await deleteSession(s.id);
      unbindAgent(s.id);
      this.sessions = this.sessions.filter((x) => x.id !== s.id);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private async handlePin(s: Session, ev: Event) {
    ev.stopPropagation();
    try {
      const r = await pinSession(s.id);
      this.sessions = this.sessions.map((x) =>
        x.id === s.id ? { ...x, is_pinned: r.is_pinned } : x
      );
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  render() {
    const pinned = this.sessions.filter((s) => s.is_pinned);
    const others = this.sessions.filter((s) => !s.is_pinned);

    return html`
      <div class="wrap">
        <button class="new-chat" @click=${() => this.handleNew()}>
          <span>+</span>
          <span>新会话</span>
        </button>

        <div class="search-row">
          <input
            type="search"
            placeholder="搜索会话…"
            .value=${this.keyword}
            @input=${(e: Event) => this.handleSearchInput(e)}
          />
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <div class="list">
          ${pinned.length > 0 ? html`
            <div class="section-title">📌 已置顶</div>
            ${pinned.map((s) => this.renderItem(s))}
          ` : ''}
          ${others.length > 0 ? html`
            ${pinned.length > 0 ? html`<div class="section-title" style="padding-top: var(--s-4);">近期</div>` : html`<div class="section-title">近期</div>`}
            ${others.map((s) => this.renderItem(s))}
          ` : ''}
          ${!this.loading && this.sessions.length === 0 ? html`
            <div class="empty-state">还没有会话</div>
          ` : ''}
        </div>

        <div class="footer">
          <button class="footer-btn" @click=${() => this.dispatchEvent(new CustomEvent('open-page', { detail: { page: 'kb' }, bubbles: true, composed: true }))}>
            <span>📚</span><span>知识库</span>
          </button>
          <button class="footer-btn" @click=${() => this.dispatchEvent(new CustomEvent('open-page', { detail: { page: 'settings' }, bubbles: true, composed: true }))}>
            <span>⚙️</span><span>设置</span>
          </button>
        </div>
      </div>
    `;
  }

  private renderItem(s: Session) {
    const date = s.updated_at ? new Date(s.updated_at) : null;
    const sub = date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
    const icon = s.is_pinned ? '📌' : '💬';
    const agentName = this.agentNameOf(s.id);
    return html`
      <div class="session-item ${s.id === this.activeId ? 'active' : ''}" @click=${() => this.handleOpen(s)}>
        <div class="session-icon">${icon}</div>
        <div class="session-meta">
          <div class="session-title">${s.title || '新会话'}</div>
          <div class="session-sub">${sub}${agentName ? ` · ${agentName}` : ''}</div>
        </div>
        <div class="session-actions">
          <button class="session-action-btn ${s.is_pinned ? 'active' : ''}" @click=${(e: Event) => this.handlePin(s, e)}>📌</button>
          <button class="session-action-btn" @click=${(e: Event) => this.handleDelete(s, e)}>🗑</button>
        </div>
      </div>
    `;
  }
}