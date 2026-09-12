/**
 * Sessions 列表页 — 列出所有会话、新建/删除/置顶
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  listSessions, createSession, deleteSession, pinSession,
  loadSettings, type Session,
} from '../lib/weknora-client';

@customElement('ll-sessions-page')
export class LlSessionsPage extends LitElement {
  static styles = css`
    :host { display: block; height: 100%; }
    .wrap { display: flex; flex-direction: column; height: 100%; }
    .search {
      padding: 8px 0;
      display: flex;
      gap: 8px;
    }
    .search input { flex: 1; }
    .list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .empty {
      text-align: center;
      color: var(--dim);
      padding: 40px 20px;
    }
    .session-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background .12s;
    }
    .session-item:hover { background: var(--bg-2); }
    .session-item.active {
      border-color: var(--accent);
      background: var(--bg-2);
    }
    .session-meta { flex: 1; min-width: 0; }
    .session-title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-sub {
      font-size: 12px;
      color: var(--dim);
      margin-top: 2px;
    }
    .actions { display: flex; gap: 4px; }
    .icon-btn {
      padding: 6px;
      border-radius: 4px;
      color: var(--dim);
    }
    .icon-btn:hover { background: var(--bg-3); color: var(--fg); }
    .icon-btn.active { color: var(--accent); }
    .pin-icon { color: var(--accent); margin-right: 4px; }
    .loading {
      text-align: center;
      padding: 12px;
      color: var(--dim);
      font-size: 13px;
    }
    .error {
      color: var(--error);
      padding: 8px 12px;
      background: var(--bg-2);
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .fab {
      position: fixed;
      bottom: 80px;
      right: 16px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--accent-fg);
      font-size: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,.2);
      border: none;
      cursor: pointer;
      z-index: 50;
    }
  `;

  @state() private sessions: Session[] = [];
  @state() private loading = false;
  @state() private error = '';
  @state() private keyword = '';
  @state() private activeId = '';

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh();
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

  private async handleNew() {
    try {
      const s = await createSession(null, loadSettings().defaultAgentId);
      this.activeId = s.id;
      this.dispatchEvent(new CustomEvent('open-chat', { detail: { sessionId: s.id } }));
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private async handleDelete(id: string, ev: Event) {
    ev.stopPropagation();
    if (!confirm('Delete this session?')) return;
    try {
      await deleteSession(id);
      this.sessions = this.sessions.filter((s) => s.id !== id);
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

  private handleSearchInput(ev: Event) {
    this.keyword = (ev.target as HTMLInputElement).value;
    clearTimeout((this as any)._searchT);
    (this as any)._searchT = setTimeout(() => this.refresh(), 300);
  }

  private handleOpen(s: Session) {
    this.activeId = s.id;
    this.dispatchEvent(new CustomEvent('open-chat', { detail: { sessionId: s.id } }));
  }

  render() {
    const pinned = this.sessions.filter((s) => s.is_pinned);
    const others = this.sessions.filter((s) => !s.is_pinned);

    return html`
      <div class="wrap">
        <div class="search">
          <input
            class="input"
            placeholder="Search sessions…"
            .value=${this.keyword}
            @input=${this.handleSearchInput}
          />
          <button class="btn" @click=${() => this.refresh()}>↻</button>
        </div>
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        ${this.loading ? html`<div class="loading">Loading…</div>` : nothing}
        <div class="list">
          ${pinned.length > 0 ? html`
            <div class="label-text" style="margin-top: 8px;">📌 Pinned</div>
            ${pinned.map((s) => this.renderItem(s))}
          ` : nothing}
          ${others.length > 0 || pinned.length === 0 ? html`
            ${pinned.length > 0 ? html`<div class="label-text" style="margin-top: 12px;">Recent</div>` : nothing}
            ${others.map((s) => this.renderItem(s))}
          ` : nothing}
          ${!this.loading && this.sessions.length === 0 ? html`
            <div class="empty">No sessions yet. Tap + to start.</div>
          ` : nothing}
        </div>
        <button class="fab" @click=${() => this.handleNew()} title="New chat">+</button>
      </div>
    `;
  }

  private renderItem(s: Session) {
    const ts = s.updated_at ? new Date(s.updated_at).toLocaleString() : '';
    return html`
      <div class="session-item ${s.id === this.activeId ? 'active' : ''}" @click=${() => this.handleOpen(s)}>
        <div class="session-meta">
          <div class="session-title">
            ${s.is_pinned ? html`<span class="pin-icon">📌</span>` : nothing}
            ${s.title || 'Untitled'}
          </div>
          <div class="session-sub">${ts}</div>
        </div>
        <div class="actions">
          <button class="icon-btn ${s.is_pinned ? 'active' : ''}" @click=${(ev: Event) => this.handlePin(s, ev)} title="Pin">📌</button>
          <button class="icon-btn" @click=${(ev: Event) => this.handleDelete(s.id, ev)} title="Delete">🗑</button>
        </div>
      </div>
    `;
  }
}