/**
 * Agent 顶部下拉选择器
 * 借鉴 ChatGPT iOS / LobeChat 的 Agent 切换方式
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { listAgents, loadSettings, saveSettings, type Agent } from '../lib/weknora-client';

@customElement('ll-agent-selector')
export class LlAgentSelector extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  @state() private open = false;
  @state() private agents: Agent[] = [];
  @state() private currentId = loadSettings().defaultAgentId || '';
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

  private handleOutsideClick = (ev: MouseEvent) => {
    if (!this.open) return;
    if (!ev.composedPath().includes(this)) this.open = false;
  };

  private async refresh() {
    try {
      this.agents = await listAgents();
      // 修正默认值：currentId 不在列表里 → 自动选 smart-reasoning 或第一个
      if (!this.agents.some((a) => a.id === this.currentId)) {
        const preferred =
          this.agents.find((a) => a.id === 'builtin-smart-reasoning') ||
          this.agents.find((a) => a.id === 'builtin-quick-answer') ||
          this.agents[0];
        if (preferred) {
          this.currentId = preferred.id;
          const s = loadSettings();
          s.defaultAgentId = preferred.id;
          saveSettings(s);
          this.dispatchEvent(new CustomEvent('agent-changed', {
            detail: { agentId: preferred.id }, bubbles: true, composed: true,
          }));
        }
      }
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private select(agentId: string) {
    this.currentId = agentId;
    const settings = loadSettings();
    settings.defaultAgentId = agentId;
    saveSettings(settings);
    this.open = false;
    this.dispatchEvent(new CustomEvent('agent-changed', {
      detail: { agentId }, bubbles: true, composed: true,
    }));
  }

  private get currentAgent(): Agent | undefined {
    return this.agents.find((a) => a.id === this.currentId);
  }

  render() {
    const current = this.currentAgent;
    const name = current?.name || (this.currentId ? this.currentId : '未选择');
    const initial = (current?.name || name).charAt(0);
    const isBuiltin = current?.is_builtin;

    return html`
      <div style="position: relative;">
        <div
          class="agent-selector ${this.open ? 'open' : ''}"
          @click=${(e: Event) => { e.stopPropagation(); this.open = !this.open; }}
        >
          <div class="agent-selector-avatar ${isBuiltin ? 'builtin' : ''}">${initial}</div>
          <span class="agent-selector-name">${name}</span>
          <span class="chevron">▼</span>
        </div>

        ${this.open ? html`
          <div class="agent-dropdown">
            ${this.error ? html`<div class="agent-dropdown-empty">加载失败：${this.error}</div>` : nothing}
            ${this.agents.length === 0 && !this.error ? html`
              <div class="agent-dropdown-empty">加载中…</div>
            ` : nothing}
            ${this.agents.map((a) => html`
              <div
                class="agent-dropdown-item ${a.id === this.currentId ? 'active' : ''}"
                @click=${() => this.select(a.id)}
              >
                <div class="agent-dropdown-item-avatar">${a.avatar || a.name.charAt(0)}</div>
                <div class="agent-dropdown-item-info">
                  <div class="agent-dropdown-item-name">${a.name}</div>
                  <div class="agent-dropdown-item-desc">${a.description || (a.is_builtin ? '内置 Agent' : '自定义 Agent')}</div>
                </div>
                ${a.id === this.currentId ? html`<span style="color:var(--accent);font-size:16px;">✓</span>` : nothing}
              </div>
            `)}
            <div
              class="agent-dropdown-item"
              style="border-top:1px solid var(--border);margin-top:4px;color:var(--accent);"
              @click=${() => {
                this.open = false;
                this.dispatchEvent(new CustomEvent('open-page', { detail: { page: 'agents' }, bubbles: true, composed: true }));
              }}
            >
              <div class="agent-dropdown-item-avatar" style="background:transparent;color:var(--accent);">⚙</div>
              <div class="agent-dropdown-item-info">
                <div class="agent-dropdown-item-name">管理所有 Agent</div>
              </div>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }
}