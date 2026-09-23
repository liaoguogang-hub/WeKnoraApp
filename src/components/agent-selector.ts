/**
 * Agent 顶部下拉选择器
 *
 * 两种模式：
 *   ① 有 sessionId —— 「本会话固定一个 agent」
 *        切换只改这个会话的绑定，不动全局默认值
 *   ② 无 sessionId —— 改全局默认 Agent（决定以后新建会话用什么）
 *
 * ⚠️ 之所以需要模式①：WeKnora 后端不持久化会话的 agent，
 *    绑定只能记在本地，详见 lib/session-agent.ts。
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import { listAgents, loadSettings, saveSettings, type Agent } from '../lib/weknora-client';
import { getBoundAgent, bindAgent } from '../lib/session-agent';

@customElement('ll-agent-selector')
export class LlAgentSelector extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  /** 有值 → 切换的是该会话的 agent；空 → 切换全局默认 Agent */
  @property({ type: String }) sessionId = '';

  @state() private open = false;
  @state() private agents: Agent[] = [];
  @state() private defaultAgentId = loadSettings().defaultAgentId || '';
  @state() private error = '';

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this.handleOutsideClick);
    this.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleOutsideClick);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId')) {
      // 换会话了 → 下拉要反映新会话绑定的 agent，并且把上个会话的下拉收起来
      this.defaultAgentId = loadSettings().defaultAgentId || '';
      this.open = false;
    }
  }

  private handleOutsideClick = (ev: MouseEvent) => {
    if (!this.open) return;
    if (!ev.composedPath().includes(this)) this.open = false;
  };

  /** 当前该显示的 agent：会话有绑定用绑定，否则用全局默认 */
  private get effectiveId(): string {
    if (this.sessionId) return getBoundAgent(this.sessionId) || this.defaultAgentId;
    return this.defaultAgentId;
  }

  private async refresh() {
    try {
      this.agents = await listAgents();
      this.defaultAgentId = loadSettings().defaultAgentId || '';
      // 当前 agent 不在列表里（被后端删了 / 默认值失效）→ 自动纠正
      if (this.agents.length > 0 && !this.agents.some((a) => a.id === this.effectiveId)) {
        const preferred =
          this.agents.find((a) => a.id === 'builtin-smart-reasoning') ||
          this.agents.find((a) => a.id === 'builtin-quick-answer') ||
          this.agents[0];
        // 有会话时只纠正这个会话的绑定；没有会话时保持原行为，改全局默认
        if (preferred) this.applyChoice(preferred.id, !!this.sessionId);
      }
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /**
   * 落盘选择。
   * @param silent 自动纠正用：只改绑定，不改全局默认值，也不广播事件
   */
  private applyChoice(agentId: string, silent = false) {
    if (this.sessionId) {
      bindAgent(this.sessionId, agentId);
    } else if (!silent) {
      const settings = loadSettings();
      settings.defaultAgentId = agentId;
      saveSettings(settings);
      this.defaultAgentId = agentId;
    }
    if (!silent) {
      this.dispatchEvent(new CustomEvent('agent-changed', {
        detail: { agentId, sessionId: this.sessionId }, bubbles: true, composed: true,
      }));
    }
  }

  private select(agentId: string) {
    this.applyChoice(agentId);
    this.open = false;
  }

  private get currentAgent(): Agent | undefined {
    return this.agents.find((a) => a.id === this.effectiveId);
  }

  render() {
    const current = this.currentAgent;
    const id = this.effectiveId;
    const name = current?.name || (id ? id : '未选择');
    const initial = (current?.name || name).charAt(0);
    const isBuiltin = current?.is_builtin;

    return html`
      <div style="position: relative;">
        <div
          class="agent-selector ${this.open ? 'open' : ''}"
          @click=${(e: Event) => { e.stopPropagation(); this.open = !this.open; }}
          title=${this.sessionId ? '本会话使用的 Agent' : '默认 Agent（新建会话使用）'}
        >
          <div class="agent-selector-avatar ${isBuiltin ? 'builtin' : ''}">${initial}</div>
          <span class="agent-selector-name">${name}</span>
          <span class="chevron">▼</span>
        </div>

        ${this.open ? html`
          <div class="agent-dropdown">
            <div class="agent-dropdown-empty" style="padding:6px 12px;text-align:left;font-size:11px;line-height:1.4;">
              ${this.sessionId ? '本会话固定使用（只影响这个会话）' : '默认 Agent（影响新建的会话）'}
            </div>
            ${this.error ? html`<div class="agent-dropdown-empty">加载失败：${this.error}</div>` : nothing}
            ${this.agents.length === 0 && !this.error ? html`
              <div class="agent-dropdown-empty">加载中…</div>
            ` : nothing}
            ${this.agents.map((a) => html`
              <div
                class="agent-dropdown-item ${a.id === this.effectiveId ? 'active' : ''}"
                @click=${() => this.select(a.id)}
              >
                <div class="agent-dropdown-item-avatar">${a.avatar || a.name.charAt(0)}</div>
                <div class="agent-dropdown-item-info">
                  <div class="agent-dropdown-item-name">${a.name}</div>
                  <div class="agent-dropdown-item-desc">${a.description || (a.is_builtin ? '内置 Agent' : '自定义 Agent')}</div>
                </div>
                ${a.id === this.effectiveId ? html`<span style="color:var(--accent);font-size:16px;">✓</span>` : nothing}
              </div>
            `)}
            <div
              class="agent-dropdown-item"
              style="border-top:1px solid var(--border);margin-top:4px;color:var(--accent);"
              @click=${() => {
                this.open = false;
                this.dispatchEvent(new CustomEvent('open-page', { detail: { page: 'settings' }, bubbles: true, composed: true }));
              }}
            >
              <div class="agent-dropdown-item-avatar" style="background:transparent;color:var(--accent);">⚙</div>
              <div class="agent-dropdown-item-info">
                <div class="agent-dropdown-item-name">默认 Agent 设置</div>
              </div>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }
}
