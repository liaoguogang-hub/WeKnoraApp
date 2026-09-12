/**
 * Agents 页 — 管理所有 Agent
 * 借鉴 Cherry Studio / LobeChat 的助手管理
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { listAgents, loadSettings, saveSettings, type Agent } from '../lib/weknora-client';

@customElement('ll-agents-page')
export class LlAgentsPage extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  @state() private agents: Agent[] = [];
  @state() private loading = false;
  @state() private error = '';
  @state() private currentId = loadSettings().defaultAgentId || '';

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.loading = true;
    this.error = '';
    try {
      this.agents = await listAgents();
      // 修正默认值：如果 currentId 不在列表里，自动选第一个（优先 smart-reasoning）
      if (!this.agents.some((a) => a.id === this.currentId)) {
        const preferred =
          this.agents.find((a) => a.id === 'builtin-smart-reasoning') ||
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
    } finally {
      this.loading = false;
    }
  }

  private setDefault(agent: Agent) {
    this.currentId = agent.id;
    const s = loadSettings();
    s.defaultAgentId = agent.id;
    saveSettings(s);
    this.dispatchEvent(new CustomEvent('agent-changed', {
      detail: { agentId: agent.id }, bubbles: true, composed: true,
    }));
  }

  render() {
    const builtins = this.agents.filter((a) => a.is_builtin);
    const customs = this.agents.filter((a) => !a.is_builtin);

    return html`
      <div style="padding: var(--s-4); display:flex; flex-direction:column; gap: var(--s-3); max-width: 720px; margin: 0 auto;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <div>
            <div style="font-size:13px;color:var(--dim);">${this.agents.length} 个可用 Agent</div>
            <div style="font-size:12px;color:var(--dim);margin-top:2px;">点击卡片设为默认</div>
          </div>
          <button class="btn sm" @click=${() => this.refresh()} ?disabled=${this.loading}>
            ${this.loading ? '加载中…' : '↻ 刷新'}
          </button>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}

        ${builtins.length > 0 ? html`
          <div class="label-text" style="margin-top: var(--s-2);">内置 Agent</div>
          ${builtins.map((a) => this.renderAgent(a))}
        ` : nothing}

        ${customs.length > 0 ? html`
          <div class="label-text" style="margin-top: var(--s-4);">自定义 Agent</div>
          ${customs.map((a) => this.renderAgent(a))}
        ` : nothing}

        ${!this.loading && this.agents.length === 0 ? html`
          <div class="empty">
            <div class="empty-icon">🤖</div>
            <div>没有可用的 Agent</div>
            <div style="font-size:12px;">去 WeKnora Web UI 创建</div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderAgent(a: Agent) {
    const active = a.id === this.currentId;
    const cfg = a.config || ({} as Agent['config']);
    return html`
      <div
        class="card"
        style="cursor:pointer; display:flex; align-items:flex-start; gap: var(--s-3); ${active ? 'border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--card));' : ''}"
        @click=${() => this.setDefault(a)}
      >
        <div style="width:42px;height:42px;border-radius:var(--r-md);background:${active ? 'var(--accent)' : 'var(--bg-2)'};color:${active ? 'var(--accent-fg)' : 'var(--fg-2)'};display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">
          ${a.avatar || a.name.charAt(0)}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:15px;">${a.name}</span>
            ${a.is_builtin ? html`<span style="font-size:10px;padding:2px 8px;border-radius:var(--r-full);background:var(--bg-2);color:var(--fg-2);">内置</span>` : nothing}
            ${active ? html`<span style="font-size:10px;padding:2px 8px;border-radius:var(--r-full);background:var(--accent);color:var(--accent-fg);">默认</span>` : nothing}
          </div>
          ${a.description ? html`<div style="font-size:13px;color:var(--fg-2);margin-top:4px;">${a.description}</div>` : nothing}
          <div style="font-size:11px;color:var(--dim);margin-top:6px;font-family:var(--font-mono);">
            ${cfg.agent_mode || 'quick-answer'}
            ${cfg.web_search_enabled ? ' · 联网' : ''}
            ${cfg.multi_turn_enabled ? ` · ${cfg.history_turns ?? 5}轮记忆` : ''}
          </div>
        </div>
      </div>
    `;
  }
}