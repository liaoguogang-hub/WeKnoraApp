/**
 * Settings 页 — baseUrl / apiKey / 默认 Agent / Web Search / 主题
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  loadSettings, saveSettings, listAgents, isConfigured,
  type WeKnoraSettings, type Agent,
} from '../lib/weknora-client';
import {
  listConnections, upsertConnection, applyConnection, deleteConnection, getActiveId,
  type Connection,
} from '../lib/connections';
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
  /** 命名连接：已保存的连接列表 / 生效中的那个 / 表单里的名称 / 正在编辑的 id */
  @state() private connections: Connection[] = [];
  @state() private activeId = '';
  @state() private connName = '';
  @state() private editingId = '';

  async connectedCallback() {
    super.connectedCallback();
    // 强制从 localStorage 重新读取，避免 @state 初始化时拿到过期/缺失的快照
    this.settings = loadSettings();
    this.refreshConnections();
    const active = listConnections().find((c) => c.id === getActiveId());
    this.connName = active ? active.name : '';
    this.editingId = active ? active.id : '';
    // 无论如何都尝试拉 Agent 列表（未配置时会失败并显示原因）
    this.loadAgents();
  }

  private refreshConnections() {
    this.connections = listConnections();
    this.activeId = getActiveId();
  }

  /** sk-abcdef…wxyz */
  private maskKey(k: string): string {
    const s = k || '';
    return s.length <= 12 ? '••••••' : `${s.slice(0, 6)}…${s.slice(-4)}`;
  }

  /**
   * 保存当前表单为一条命名连接，并让它立即生效。
   *
   * 这样「换一个 WeKnora / 知识库」就变成两步：填一次 → 以后从列表里点一下。
   * 不需要再重新敲 baseUrl 和 API Key。
   */
  private async saveConnection() {
    await this.updateComplete;
    const baseUrl = (this.settings.baseUrl || '').trim();
    const apiKey = (this.settings.apiKey || '').trim();
    if (!baseUrl || !apiKey) {
      this.status = '⚠️ baseUrl 和 API Key 都不能为空，请在上方输入框填写';
      this.statusType = 'err';
      return;
    }
    const prevBase = (this.connections.find((c) => c.id === this.activeId)?.baseUrl || '').replace(/\/+$/, '');
    const c = upsertConnection(
      { name: this.connName, baseUrl, apiKey, defaultAgentId: this.settings.defaultAgentId },
      this.editingId || undefined
    );
    applyConnection(c);
    this.settings = loadSettings();
    this.connName = c.name;
    this.editingId = c.id;
    this.refreshConnections();
    this.status = `已保存连接「${c.name}」`;
    this.statusType = 'ok';
    setTimeout(() => { if (this.status === `已保存连接「${c.name}」`) this.status = ''; }, 2500);

    await this.loadAgents();
    if (this.agentsError) {
      this.status = `已保存「${c.name}」，但无法拉取 Agent 列表：${this.agentsError}`;
      this.statusType = 'err';
    }
    this.dispatchEvent(new CustomEvent('settings-saved', { bubbles: true, composed: true }));
    // 换了服务器才重置会话；同一台服务器重新保存不该把当前会话丢掉
    if (prevBase && prevBase !== c.baseUrl.replace(/\/+$/, '')) {
      this.dispatchEvent(new CustomEvent('connection-changed', { bubbles: true, composed: true }));
    }
  }

  /** 切换到某条已保存的连接 */
  private async switchTo(c: Connection) {
    if (c.id === this.activeId) return;
    const prevBase = (loadSettings().baseUrl || '').replace(/\/+$/, '');
    applyConnection(c);
    this.settings = loadSettings();
    this.connName = c.name;
    this.editingId = c.id;
    this.refreshConnections();
    this.status = `已切换到「${c.name}」`;
    this.statusType = 'ok';
    setTimeout(() => { if (this.status === `已切换到「${c.name}」`) this.status = ''; }, 2500);
    this.agentsError = '';
    await this.loadAgents();
    this.dispatchEvent(new CustomEvent('settings-saved', { bubbles: true, composed: true }));
    // 只有真的换了服务器才重置会话。同一台服务器上有多条命名连接（例如同一地址的
    // 不同用途）时，互相切换不该把当前会话丢掉。
    if (prevBase !== c.baseUrl.replace(/\/+$/, '')) {
      this.dispatchEvent(new CustomEvent('connection-changed', { bubbles: true, composed: true }));
    }
  }

  /** 把某条连接载入表单编辑（改完点保存） */
  private editConnection(c: Connection) {
    this.settings = { ...this.settings, baseUrl: c.baseUrl, apiKey: c.apiKey };
    this.connName = c.name;
    this.editingId = c.id;
    this.status = `正在编辑「${c.name}」—— 改完点💾保存`;
    this.statusType = 'ok';
  }

  private newConnection() {
    this.settings = { ...this.settings, baseUrl: '', apiKey: '' };
    this.connName = '';
    this.editingId = '';
    this.status = '新建连接：填名称 / 地址 / 密钥后点💾保存';
    this.statusType = 'ok';
  }

  private removeConnection(c: Connection) {
    if (!confirm(`删除连接「${c.name}」？\n（只删除本机保存的配置，不影响服务器上的数据）`)) return;
    deleteConnection(c.id);
    this.refreshConnections();
    if (this.editingId === c.id) { this.connName = ''; this.editingId = ''; }
    this.status = `已删除「${c.name}」`;
    this.statusType = 'ok';
    setTimeout(() => { this.status = ''; }, 2000);
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

  /** 兼容旧调用：保存现在走「命名连接」流程 */
  private async save() {
    await this.saveConnection();
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
            <label class="label-text">连接名称</label>
            <input
              class="input"
              placeholder="例如：家里 NAS / 本地 WeKnora"
              .value=${this.connName}
              @input=${(e: Event) => { this.connName = (e.target as HTMLInputElement).value; }}
            />
            <div style="font-size:11px;color:var(--dim);margin-top:4px;">
              给这个连接起个名字，保存后就能在下面的列表里一键切换${this.editingId ? '（当前正在编辑一条已保存的连接）' : ''}
            </div>
          </div>
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
          <div style="display:flex;gap:var(--s-2);flex-wrap:wrap;">
            <button class="btn primary" @click=${() => this.saveConnection()}>💾 保存</button>
            <button class="btn" @click=${() => this.newConnection()}>＋ 新建</button>
            <button class="btn" @click=${() => this.clear()}>Clear</button>
          </div>
        </div>

        ${this.connections.length > 0 ? html`
          <div class="card">
            <h3 style="margin:0 0 var(--s-3);font-size:14px;font-weight:600;">🔀 已保存的连接</h3>
            <div style="display:flex;flex-direction:column;gap:var(--s-2);">
              ${this.connections.map((c) => html`
                <div
                  class="conn-row ${c.id === this.activeId ? 'active' : ''}"
                  @click=${() => this.switchTo(c)}
                  title=${c.id === this.activeId ? '当前使用中' : '点击切换到该连接'}
                >
                  <span class="conn-dot"></span>
                  <div class="conn-meta">
                    <div class="conn-name">
                      ${c.name}
                      ${c.id === this.activeId ? html`<span class="conn-badge">使用中</span>` : nothing}
                    </div>
                    <div class="conn-url">${c.baseUrl} · ${this.maskKey(c.apiKey)}</div>
                  </div>
                  <div class="conn-actions" @click=${(e: Event) => e.stopPropagation()}>
                    <button class="btn sm" @click=${() => this.editConnection(c)}>编辑</button>
                    <button class="btn sm" @click=${() => this.removeConnection(c)}>删除</button>
                  </div>
                </div>
              `)}
            </div>
            <div style="font-size:11px;color:var(--dim);margin-top:var(--s-3);line-height:1.6;">
              点击任意一行即可切换（会同时切到那台服务器上的知识库 / Agent）。
              切换后当前会话会被清空并重新开始——不同服务器上的会话互不相通。
            </div>
          </div>
        ` : nothing}

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
          <div class="muted">WeKnora Android Client v${__APP_VERSION__}</div>
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