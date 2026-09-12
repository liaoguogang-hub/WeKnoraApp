/**
 * Settings 页 — baseUrl / apiKey / 默认 Agent / Web Search / 主题
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  loadSettings, saveSettings, listAgents, isConfigured,
  type WeKnoraSettings, type Agent,
} from '../lib/weknora-client';
import { loadTheme, saveTheme, applyTheme, PRESETS, type ThemeSettings } from '../lib/theme';

@customElement('ll-settings-page')
export class LlSettingsPage extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  @state() private settings: WeKnoraSettings = loadSettings();
  @state() private agents: Agent[] = [];
  @state() private status = '';
  @state() private statusType: 'ok' | 'err' = 'ok';
  @state() private currentThemePreset: string = loadTheme().presetName || '默认深色';
  @state() private agentsLoading = false;
  @state() private agentsError = '';

  async connectedCallback() {
    super.connectedCallback();
    // 强制从 localStorage 重新读取，避免 @state 初始化时拿到过期/缺失的快照
    this.settings = loadSettings();
    // 无论如何都尝试拉 Agent 列表（未配置时会失败并显示原因）
    this.loadAgents();
  }

  /** 拉取 Agent 列表（含错误与加载状态） */
  private async loadAgents() {
    const s = loadSettings();
    if (!s.baseUrl || !s.apiKey) {
      this.agentsError = '未配置 baseUrl / API Key';
      return;
    }
    this.agentsLoading = true;
    this.agentsError = '';
    try {
      this.agents = await listAgents();
      console.log('[weknora-settings] agents loaded:', this.agents.map((a) => a.id));
      // 如果当前默认 Agent 不在列表里，自动纠正
      if (this.agents.length > 0 && !this.agents.some((a) => a.id === this.settings.defaultAgentId)) {
        const preferred =
          this.agents.find((a) => a.id === 'builtin-smart-reasoning') ||
          this.agents.find((a) => a.id === 'builtin-quick-answer') ||
          this.agents[0];
        this.updateField('defaultAgentId', preferred.id);
        saveSettings(this.settings);
      }
    } catch (e) {
      this.agentsError = (e as Error).message;
      console.warn('[weknora-settings] loadAgents failed:', e);
    } finally {
      this.agentsLoading = false;
    }
  }

  private updateField<K extends keyof WeKnoraSettings>(key: K, value: WeKnoraSettings[K]) {
    this.settings = { ...this.settings, [key]: value };
  }

  private async save() {
    console.log('[weknora-settings] save clicked', { baseUrl: this.settings.baseUrl, apiKeyLen: this.settings.apiKey?.length });
    // 把内存里的 settings 强制刷一遍（避免 Lit input 事件还没同步）
    await this.updateComplete;
    saveSettings(this.settings);
    const reloaded = loadSettings();
    console.log('[weknora-settings] reloaded after save', { baseUrl: reloaded.baseUrl, apiKeyLen: reloaded.apiKey?.length });
    if (!reloaded.baseUrl || !reloaded.apiKey) {
      this.status = '⚠️ baseUrl 和 API Key 都不能为空，请在上方输入框填写（不要只看到 placeholder）';
      this.statusType = 'err';
      return;
    }
    this.status = '已保存';
    this.statusType = 'ok';
    setTimeout(() => { this.status = ''; }, 2000);

    // Reload agents after save
    await this.loadAgents();
    if (this.agentsError) {
      this.status = '已保存，但无法拉取 Agent 列表：' + this.agentsError;
      this.statusType = 'err';
    }

    this.dispatchEvent(new CustomEvent('settings-saved', { bubbles: true, composed: true }));
  }

  private clear() {
    if (!confirm('清除所有本地设置？')) return;
    localStorage.removeItem('weknora-settings');
    this.settings = loadSettings();
    this.status = '已清除';
    this.statusType = 'ok';
  }

  render() {
    return html`
      <div style="padding: var(--s-4); display: flex; flex-direction: column; gap: var(--s-4); max-width: 640px; margin: 0 auto;">
        ${this.status ? html`<div style="padding:10px 14px;border-radius:var(--r-md);font-size:13px;background:${this.statusType === 'ok' ? 'rgba(30,166,114,.1)' : 'rgba(214,58,58,.1)'};color:${this.statusType === 'ok' ? 'var(--success)' : 'var(--error)'};">${this.status}</div>` : ''}

        <div class="card">
          <h3 style="margin:0 0 var(--s-3);font-size:14px;font-weight:600;">🔌 连接 WeKnora</h3>
          <div style="margin-bottom: var(--s-3);">
            <label class="label-text">API Base URL</label>
            <input
              class="input"
              placeholder="例如: http://192.168.50.201:9080"
              .value=${this.settings.baseUrl || ''}
              @input=${(e: Event) => this.updateField('baseUrl', (e.target as HTMLInputElement).value)}
            />
          </div>
          <div style="margin-bottom: var(--s-3);">
            <label class="label-text">API Key</label>
            <input
              class="input"
              type="password"
              placeholder="sk-..."
              .value=${this.settings.apiKey || ''}
              @input=${(e: Event) => this.updateField('apiKey', (e.target as HTMLInputElement).value)}
            />
          </div>
          <div style="display:flex;gap:var(--s-2);">
            <button class="btn primary" @click=${() => this.save()}>💾 Save</button>
            <button class="btn" @click=${() => this.clear()}>Clear</button>
          </div>
        </div>

        <div class="card">
          <h3 style="margin:0 0 var(--s-3);font-size:14px;font-weight:600;">⚙️ 默认行为</h3>
          <div style="margin-bottom: var(--s-3);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <label class="label-text" style="margin:0;">Default Agent</label>
              <button class="btn sm ghost" style="padding:2px 8px;font-size:12px;" @click=${() => this.loadAgents()} ?disabled=${this.agentsLoading}>
                ${this.agentsLoading ? '加载中…' : '↻ 刷新'}
              </button>
            </div>
            ${this.agentsError ? html`
              <div style="font-size:12px;color:var(--error);margin-bottom:6px;">⚠️ ${this.agentsError}</div>
            ` : ''}
            <select
              class="input"
              .value=${this.settings.defaultAgentId}
              @change=${(e: Event) => {
                this.updateField('defaultAgentId', (e.target as HTMLSelectElement).value);
                saveSettings(this.settings);
              }}
            >
              ${this.agents.length === 0
                ? html`<option value="${this.settings.defaultAgentId}">${this.settings.defaultAgentId || '（未加载）'}</option>`
                : this.agents.map(
                    (a) => html`<option value=${a.id} ?selected=${a.id === this.settings.defaultAgentId}>${a.name}${a.is_builtin ? ' · 内置' : ''}</option>`,
                  )}
            </select>
            <div style="font-size:11px;color:var(--dim);margin-top:6px;">
              ${this.agents.length > 0
                ? `已加载 ${this.agents.length} 个 Agent`
                : '未加载到 Agent，请检查连接后点 ↻ 刷新'}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:var(--s-2);">
            <input
              type="checkbox"
              id="web-toggle"
              .checked=${this.settings.webSearchEnabled}
              @change=${(e: Event) => {
                this.updateField('webSearchEnabled', (e.target as HTMLInputElement).checked);
                saveSettings(this.settings);
              }}
            />
            <label for="web-toggle">默认启用联网搜索</label>
          </div>
        </div>

        <div class="card">
          <h3 style="margin:0 0 var(--s-3);font-size:14px;font-weight:600;">🎨 主题</h3>
          <div class="theme-grid">
            ${Object.entries(PRESETS).map(([key, t]) => html`
              <div class="theme-card ${this.currentThemePreset === key ? 'active' : ''}" @click=${() => this.setTheme(key)}>
                <div class="theme-card-name">${key}</div>
                <div class="theme-card-preview">
                  <div style="background:${t.bg}"></div>
                  <div style="background:${t.bg2}"></div>
                  <div style="background:${t.accent}"></div>
                  <div style="background:${t.fg}"></div>
                </div>
              </div>
            `)}
          </div>
        </div>

        <div class="card">
          <h3 style="margin:0 0 var(--s-3);font-size:14px;font-weight:600;">ℹ️ 关于</h3>
          <div class="muted">WeKnora Android Client v0.2.0</div>
          <div class="muted" style="margin-top: 4px;">Powered by Capacitor + Lit + TypeScript</div>
        </div>
      </div>
    `;
  }

  private setTheme(presetName: string) {
    const t = PRESETS[presetName];
    if (!t) return;
    this.currentThemePreset = presetName;
    saveTheme(t);
    applyTheme(t);
  }
}