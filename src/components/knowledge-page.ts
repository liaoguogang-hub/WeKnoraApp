/**
 * KB 文件浏览器
 *  - KB 列表 → 文件列表（带下载指示灯）→ 文件详情（预览 + 4 个操作按钮）
 *
 * 下载策略：
 *  - 已下载过 → 直接复用公共下载目录里的文件，不重复请求
 *  - 下载中 → 记录到 downloadingId（按文件维度，切文件不会互相干扰）
 *  - 下载结果记录在 localStorage（fileId → {name, uri, path, size, ts}）
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  listKnowledgeBases, listKnowledge, getKnowledge,
  type KnowledgeBase, type Knowledge, type KnowledgeDetail,
  loadSettings,
} from '../lib/weknora-client';
import {
  saveToDownloads, findDownloaded, openFileNative, openFileManager,
  deleteDownloaded,
} from '../lib/file-tools';

const DOWNLOAD_MAP_KEY = 'weknora-downloads-v2';

interface DownloadedInfo {
  name: string;
  uri: string;
  path: string;
  size: number;
  ts: number;
}

type View = 'kbs' | 'folder';

@customElement('ll-knowledge-page')
export class LlKnowledgePage extends LitElement {
  /** Light DOM —— 使用全局 styles.css */
  protected createRenderRoot() { return this; }

  @state() private view: View = 'kbs';
  @state() private kbs: KnowledgeBase[] = [];
  @state() private currentKB: KnowledgeBase | null = null;
  @state() private files: Knowledge[] = [];
  @state() private detail: KnowledgeDetail | null = null;
  @state() private keyword = '';
  @state() private loading = false;
  @state() private error = '';
  @state() private toast = '';
  /** 正在下载的文件 id（按文件维度，避免切换文件时状态串台） */
  @state() private downloadingId = '';
  /** 已下载记录：fileId → 文件位置 */
  @state() private dlMap: Record<string, DownloadedInfo> = {};
  /** 详情页内联提示（下载/打开结果） */
  @state() private detailMsg = '';

  private _toastTimer: any = null;

  // ================= 生命周期 =================

  async connectedCallback() {
    super.connectedCallback();
    this.dlMap = this.loadDlMap();
    await this.refreshKBs();
  }

  // ================= 下载记录持久化 =================

  private loadDlMap(): Record<string, DownloadedInfo> {
    try {
      const raw = localStorage.getItem(DOWNLOAD_MAP_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  private saveDlMap() {
    localStorage.setItem(DOWNLOAD_MAP_KEY, JSON.stringify(this.dlMap));
  }

  private markDownloaded(id: string, info: DownloadedInfo) {
    this.dlMap = { ...this.dlMap, [id]: info };
    this.saveDlMap();
  }

  private unmarkDownloaded(id: string) {
    const m = { ...this.dlMap };
    delete m[id];
    this.dlMap = m;
    this.saveDlMap();
  }

  private showToast(msg: string) {
    this.toast = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast = ''; }, 2500);
  }

  private detailSay(msg: string) {
    this.detailMsg = msg;
    setTimeout(() => { if (this.detailMsg === msg) this.detailMsg = ''; }, 3000);
  }

  // ================= KB 列表 =================

  private async refreshKBs() {
    this.loading = true;
    this.error = '';
    try {
      this.kbs = await listKnowledgeBases();
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private openKB(kb: KnowledgeBase) {
    this.currentKB = kb;
    this.view = 'folder';
    this.keyword = '';
    this.loadFiles();
  }

  private async loadFiles() {
    if (!this.currentKB) return;
    this.loading = true;
    this.error = '';
    try {
      const { items } = await listKnowledge(this.currentKB.id, {
        keyword: this.keyword || undefined,
        pageSize: 200,
      });
      this.files = items;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private backToKBs() {
    this.view = 'kbs';
    this.currentKB = null;
    this.files = [];
    this.keyword = '';
    this.detail = null;
  }

  // ================= 文件详情 =================

  private async openDetail(k: Knowledge) {
    this.detailMsg = '';
    this.error = '';
    try {
      this.detail = await getKnowledge(k.id);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private closeDetail() {
    this.detail = null;
    this.detailMsg = '';
  }

  private fileNameOf(d: Knowledge | KnowledgeDetail): string {
    return (d as any).file_name || d.title || 'download';
  }

  /** 当前详情文件是否已下载 */
  private isDetailDownloaded(): boolean {
    if (!this.detail) return false;
    return !!this.dlMap[this.detail.id];
  }

  // ================= 下载 =================

  /**
   * 下载（或复用已下载）
   *  - 已下载 → 直接提示，不重复请求
   *  - 下载中（同文件）→ 忽略重复点击
   *  - 下载中（其它文件）→ 允许并行，各自独立状态
   */
  private async downloadCurrent(): Promise<DownloadedInfo | null> {
    const d = this.detail;
    if (!d) return null;
    const fileId = d.id;
    const fileName = this.fileNameOf(d);

    // 1) 已下载 → 复用
    const cached = this.dlMap[fileId];
    if (cached) {
      this.detailSay('✅ 已下载，无需重复下载');
      return cached;
    }

    // 2) 同一文件正在下载 → 忽略
    if (this.downloadingId === fileId) return null;

    // 3) 先问一下磁盘上是否已有（上次会话下载过）
    try {
      const found = await findDownloaded(fileName);
      if (found.exists && found.uri) {
        const info: DownloadedInfo = {
          name: fileName,
          uri: found.uri,
          path: found.path || '',
          size: found.size || 0,
          ts: Date.now(),
        };
        this.markDownloaded(fileId, info);
        this.detailSay('✅ 该文件已存在于下载目录');
        return info;
      }
    } catch { /* 忽略，继续下载 */ }

    // 4) 真正下载
    this.downloadingId = fileId;
    this.detailSay('正在下载…');
    try {
      const settings = loadSettings();
      const url = `${settings.baseUrl.replace(/\/+$/, '')}/api/v1/knowledge/${fileId}/download`;
      const resp = await fetch(url, { headers: { 'X-API-Key': settings.apiKey } });
      if (!resp.ok) throw new Error(`服务端返回 HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (blob.size === 0) throw new Error('文件为空');
      const base64 = await this.blobToBase64(blob);

      // 保存到「公共下载目录 /WeKnora」—— 系统文件管理器可见
      const saved = await saveToDownloads(fileName, base64);
      const info: DownloadedInfo = saved
        ? { name: fileName, uri: saved.uri, path: saved.path, size: blob.size, ts: Date.now() }
        : { name: fileName, uri: '', path: '(WebView 下载)', size: blob.size, ts: Date.now() };

      if (!saved) {
        // Web 兜底
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl; a.download = fileName;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 800);
      }

      this.markDownloaded(fileId, info);
      this.detailSay(`✅ 已下载到「下载/WeKnora」(${this.formatSize(blob.size)})`);
      return info;
    } catch (e) {
      console.error('[kb] download failed:', e);
      this.detailSay('❌ 下载失败：' + (e as Error).message);
      return null;
    } finally {
      // 只清掉自己的状态，不影响别的文件
      if (this.downloadingId === fileId) this.downloadingId = '';
    }
  }

  // ================= 操作 =================

  private async openFile() {
    const d = this.detail;
    if (!d) return;
    const info = this.dlMap[d.id];
    if (!info) {
      this.detailSay('请先下载该文件');
      return;
    }
    if (!info.uri) {
      this.detailSay('文件位置未知，请重新下载');
      return;
    }
    const ok = await openFileNative(info.uri, info.name, '选择打开方式');
    if (!ok) this.detailSay('没有可打开该文件的应用');
  }

  private async shareFile() {
    const d = this.detail;
    if (!d) return;
    const info = this.dlMap[d.id];
    if (!info?.uri) {
      this.detailSay('请先下载该文件');
      return;
    }
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: info.name,
        text: info.name,
        files: [info.uri],
        dialogTitle: '分享到…',
      });
    } catch (e) {
      const m = ((e as Error).message || '').toLowerCase();
      if (m.includes('cancel')) return;
      this.detailSay('分享失败：' + (e as Error).message);
    }
  }

  private async openFileMgr() {
    const d = this.detail;
    const info = d ? this.dlMap[d.id] : undefined;
    const ok = await openFileManager(info?.name, info?.uri);
    if (!ok) this.detailSay('未找到系统文件管理器');
  }

  private async removeDownload() {
    const d = this.detail;
    if (!d) return;
    const info = this.dlMap[d.id];
    if (!info) return;
    if (!confirm(`删除已下载的「${info.name}」？`)) return;
    await deleteDownloaded(info.uri, info.name);
    this.unmarkDownloaded(d.id);
    this.detailSay('已删除本地文件');
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const r = reader.result as string;
        const i = r.indexOf(',');
        resolve(i >= 0 ? r.substring(i + 1) : r);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ================= 渲染工具 =================

  private getFileIcon(name: string): string {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map: Record<string, string> = {
      pdf: '📕', doc: '📘', docx: '📘',
      xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
      md: '📝', txt: '📄',
      jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼',
      mp3: '🎵', wav: '🎵', m4a: '🎵',
      mp4: '🎬', mov: '🎬',
      zip: '📦', epub: '📗', html: '🌐', htm: '🌐', json: '🗂',
    };
    return map[ext] || '📄';
  }

  private formatSize(bytes?: number): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ================= 渲染 =================

  render() {
    if (this.detail) return this.renderDetail();
    if (this.view === 'folder') return this.renderFolder();
    return this.renderKBs();
  }

  private renderKBs() {
    return html`
      <div style="padding: var(--s-4); max-width: 820px; margin: 0 auto;">
        ${this.toast ? html`<div class="toast">${this.toast}</div>` : ''}
        ${this.error ? html`<div class="error">${this.error}</div>` : ''}
        <div style="margin-bottom: var(--s-3); font-size: 13px; color: var(--dim);">
          ${this.kbs.length} 个知识库
        </div>
        ${this.loading && this.kbs.length === 0 ? html`<div class="empty">加载中…</div>` : ''}
        ${!this.loading && this.kbs.length === 0 ? html`
          <div class="empty">
            <div class="empty-icon">📚</div>
            <div>还没有知识库</div>
            <div style="font-size:12px;">去 WeKnora Web UI 创建</div>
          </div>
        ` : ''}
        <div class="kb-grid">
          ${this.kbs.map((kb) => html`
            <div class="kb-card" @click=${() => this.openKB(kb)}>
              <div class="kb-icon">📚</div>
              <div class="kb-info">
                <div class="kb-name">${kb.name}</div>
                <div class="kb-meta">${kb.knowledge_count} 个文档 · ${kb.type}</div>
                ${kb.description ? html`<div class="kb-desc">${kb.description}</div>` : ''}
              </div>
              <div class="kb-chevron">›</div>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private renderFolder() {
    const dlCount = this.files.filter((f) => this.dlMap[f.id]).length;
    return html`
      <div style="padding: var(--s-4); max-width: 820px; margin: 0 auto;">
        ${this.toast ? html`<div class="toast">${this.toast}</div>` : ''}
        <div style="display:flex;align-items:center;gap:var(--s-2);margin-bottom:var(--s-3);">
          <button class="back-btn" @click=${() => this.backToKBs()}>‹</button>
          <div style="flex:1;font-weight:600;font-size:16px;">${this.currentKB?.name}</div>
          <span style="font-size:12px;color:var(--dim);">
            ${this.files.length} 个文件${dlCount ? ` · 已下载 ${dlCount}` : ''}
          </span>
        </div>
        <input
          class="input"
          type="search"
          placeholder="搜索文件…"
          .value=${this.keyword}
          @input=${(e: Event) => {
            this.keyword = (e.target as HTMLInputElement).value;
            clearTimeout((this as any)._t);
            (this as any)._t = setTimeout(() => this.loadFiles(), 300);
          }}
          style="margin-bottom: var(--s-3);"
        />
        ${this.error ? html`<div class="error">${this.error}</div>` : ''}
        <div class="tree">
          ${this.loading ? html`<div class="empty">加载中…</div>` : ''}
          ${!this.loading && this.files.length === 0 ? html`<div class="empty">空文件夹</div>` : ''}
          ${this.files.map((f) => this.renderFileRow(f))}
        </div>
      </div>
    `;
  }

  private renderFileRow(f: Knowledge) {
    const isDownloaded = !!this.dlMap[f.id];
    const isDownloading = this.downloadingId === f.id;
    return html`
      <div class="file-row" @click=${() => this.openDetail(f)}>
        <span
          class="dl-lamp ${isDownloaded ? 'on' : ''} ${isDownloading ? 'busy' : ''}"
          title=${isDownloaded ? '已下载' : (isDownloading ? '下载中' : '未下载')}
        ></span>
        <span class="file-icon">${this.getFileIcon(f.file_name || f.title)}</span>
        <span class="file-name">${f.title || f.file_name}</span>
        ${isDownloading ? html`<span class="file-status processing">下载中</span>` : nothing}
        ${f.parse_status && !isDownloading ? html`<span class="file-status ${f.parse_status}">${f.parse_status}</span>` : nothing}
        <span class="file-meta">${this.formatSize(f.file_size)}</span>
      </div>
    `;
  }

  private renderDetail() {
    const d = this.detail!;
    const info = this.dlMap[d.id];
    const isDownloaded = !!info;
    const isDownloading = this.downloadingId === d.id;

    return html`
      <div class="detail-overlay">
        <div class="detail-header">
          <button class="back-btn" @click=${() => this.closeDetail()}>‹</button>
          <div class="detail-title">${d.title || d.file_name}</div>
        </div>

        <div class="detail-meta">
          ${d.file_extension ? html`<span>📄 ${d.file_extension.toUpperCase()}</span>` : nothing}
          ${d.file_size ? html`<span>💾 ${this.formatSize(d.file_size)}</span>` : nothing}
          ${d.chunk_count != null ? html`<span>🧩 ${d.chunk_count} chunks</span>` : nothing}
          ${d.parse_status ? html`<span>📊 ${d.parse_status}</span>` : nothing}
          ${isDownloaded ? html`<span style="color:var(--success);">✅ 已下载</span>` : nothing}
          ${d.created_at ? html`<span>📅 ${d.created_at.substring(0, 10)}</span>` : nothing}
        </div>

        <!-- 4 个操作按钮：下载 / 打开 / 分享 / 文件管理 -->
        <div class="detail-actions">
          <button
            class="detail-action ${isDownloaded ? 'done' : 'primary'} ${isDownloading ? 'busy' : ''}"
            ?disabled=${isDownloading}
            @click=${() => this.downloadCurrent()}
          >
            <span class="detail-action-icon">${isDownloaded ? '✅' : (isDownloading ? '⏳' : '⬇')}</span>
            <span>${isDownloaded ? '已下载' : (isDownloading ? '下载中' : '下载')}</span>
          </button>
          <button class="detail-action" @click=${() => this.openFile()}>
            <span class="detail-action-icon">👁</span>
            <span>打开</span>
          </button>
          <button class="detail-action" @click=${() => this.shareFile()}>
            <span class="detail-action-icon">📤</span>
            <span>分享</span>
          </button>
          <button class="detail-action" @click=${() => this.openFileMgr()}>
            <span class="detail-action-icon">📁</span>
            <span>文件管理</span>
          </button>
        </div>

        ${this.detailMsg ? html`
          <div class="detail-banner">${this.detailMsg}</div>
        ` : nothing}

        ${isDownloaded && info?.path ? html`
          <div class="detail-path">
            📂 保存位置：${info.path}
            <button class="detail-path-btn" @click=${() => this.removeDownload()}>删除本地文件</button>
          </div>
        ` : nothing}

        <div class="detail-body">${d.content || '(无内容)'}</div>
        ${this.toast ? html`<div class="toast">${this.toast}</div>` : nothing}
      </div>
    `;
  }
}
