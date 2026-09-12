/**
 * Chat 页 — 流式 Agent 对话（基于 WeKnora 后端的 SSE）
 *
 * v0.2：加入端侧 rerank（leoliao-app V36.2 同款）
 *   - WeKnora 后端返回 references（已含 knowledge_id + content + score）
 *   - App 端可选地跑 cross-encoder 或 BM25 二次精排
 *   - 重排后顺序展示 references + 显示 rerank 元数据（level / duration）
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import {
  agentChatStream, loadMessages, loadSettings, stopGeneration,
  type AgentEvent, type Message, type StreamHandle,
} from '../lib/weknora-client';
import { rerank as doRerank, type RerankCandidate, type RerankStats } from '../lib/reranker';

const RERANK_KEY = 'weknora-rerank-settings';

/**
 * 把后端返回的技术性错误翻译成用户看得懂的一句话。
 * 后端原始错误形如：
 *   LLM call failed: create chat completion stream: error, status code: 429,
 *   status: 429 Too Many Requests, message: 已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)
 */
function friendlyError(raw: string): string {
  const s = raw || '';
  if (/\b429\b|用量上限|Too Many Requests|quota|insufficient/i.test(s)) {
    // 尽量把服务端给的原始中文提示也带上
    const m = s.match(/message:\s*([^。]*。?)/);
    const detail = m?.[1]?.trim();
    return `模型额度已用尽${detail ? '：' + detail : ''}\n请到模型服务商处升级套餐或充值后重试。`;
  }
  if (/\b401\b|unauthorized|invalid api key/i.test(s)) {
    return 'API Key 无效或已过期，请到「设置」里重新填写。';
  }
  if (/\b403\b|forbidden/i.test(s)) return '没有权限访问该资源，请检查 API Key 的权限范围。';
  if (/\b404\b|not found/i.test(s)) return '接口不存在，请检查「设置」里的服务地址是否正确。';
  if (/\b5\d\d\b/.test(s)) return '服务端异常（5xx），请稍后重试。';
  if (/timeout|timed out/i.test(s)) return '请求超时，请重试。';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

interface RerankPref {
  enabled: boolean;
  topN: number;
  forceFallback: boolean;
}

interface UiBubble {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools: { name: string; result?: string; status: 'calling' | 'done' }[];
  references: { id?: string; title: string; score: number; content?: string }[];
  rerankStats?: RerankStats;
  /** 已经渲染过错误行 —— 服务端同一批可能重复发多条 error，只保留第一条 */
  errored?: boolean;
  streaming: boolean;
}

@customElement('ll-chat-page')
export class LlChatPage extends LitElement {
  /** Light DOM —— 使用全局 styles.css（同 leoliao-app） */
  protected createRenderRoot() { return this; }

  @property({ type: String }) sessionId = '';
  @state() private bubbles: UiBubble[] = [];
  @state() private draft = '';
  @state() private streaming = false;
  @state() private error = '';
  @state() private webSearch = loadSettings().webSearchEnabled;
  @state() private currentMessageId = '';
  @state() private rerankPref: RerankPref = {
    enabled: false,
    topN: 10,
    forceFallback: false,
    ...(JSON.parse(localStorage.getItem(RERANK_KEY) || '{}')) };
  private streamHandle: StreamHandle | null = null;
  private _assistantMessageId = '';
  @state() private toast = '';

  private saveRerankPref() {
    localStorage.setItem(RERANK_KEY, JSON.stringify(this.rerankPref));
  }

  private showToast(msg: string) {
    this.toast = msg;
    setTimeout(() => { if (this.toast === msg) this.toast = ''; }, 2000);
  }

  async connectedCallback() {
    super.connectedCallback();
    if (this.sessionId) await this.loadSession();
  }

  /**
   * 响应 sessionId 变化：
   *  1) 先取消上一个会话正在进行的流（否则会「结束不了、也无法切会话」）
   *  2) 再加载新会话历史
   */
  async updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId')) {
      const sid = this.sessionId;
      if (sid !== this._loadedSessionId || sid !== this._activeSessionId) {
        // 换了会话 → 中止旧流
        this.cancelStream();
        this._activeSessionId = sid;
        if (sid) {
          await this.loadSession();
          this._loadedSessionId = sid;
        } else {
          this.bubbles = [];
          this._loadedSessionId = '';
        }
      }
    }
    if (changed.has('bubbles')) {
      requestAnimationFrame(() => {
        const body = this.querySelector('#chat-body') as HTMLElement;
        if (body) body.scrollTop = body.scrollHeight;
      });
    }
  }

  private _loading = false;
  private _loadedSessionId = '';
  private _activeSessionId = '';

  private async loadSession() {
    if (!this.sessionId || this._loading) return;
    this._loading = true;
    this.error = '';
    this.bubbles = [];
    try {
      const msgs = await loadMessages(this.sessionId, 100);
      // ⚠️ 后端 /messages/:id/load 返回「最近 N 条」，顺序可能是倒序。
      // 必须按 created_at 升序排列，否则会出现「答复在上、提问在下」。
      const sorted = [...msgs].sort((a, b) => {
        const ta = Date.parse(a.created_at || '') || 0;
        const tb = Date.parse(b.created_at || '') || 0;
        return ta - tb;
      });
      this.bubbles = sorted.map((m) => ({
        id: m.id,
        role: m.role,
        // 后端出错时会落库一条内容为空的 assistant 消息。
        // 直接渲染就是「空白气泡」，用户完全不知道发生了什么，这里补一个说明。
        content:
          m.role === 'assistant' && !String(m.content || '').trim()
            ? '⚠️ 本次没有返回内容（通常是模型额度不足或后端异常）。'
            : m.content,
        errored: m.role === 'assistant' && !String(m.content || '').trim(),
        tools: [],
        references: (m.knowledge_references || []).map((r) => ({
          title: r.knowledge_title || 'Untitled',
          score: r.score,
          content: r.content,
        })),
        streaming: false,
      }));
      this._loadedSessionId = this.sessionId;
      console.log('[chat] loaded', sorted.length, 'messages for', this.sessionId);
    } catch (e) {
      this.error = (e as Error).message;
      console.warn('[chat] loadSession failed:', e);
    } finally {
      this._loading = false;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelStream();
  }

  private handleInput(ev: Event) {
    this.draft = (ev.target as HTMLTextAreaElement).value;
  }

  private handleKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  private toggleWeb() {
    this.webSearch = !this.webSearch;
    const s = loadSettings();
    s.webSearchEnabled = this.webSearch;
    localStorage.setItem('weknora-settings', JSON.stringify(s));
    this.showToast(this.webSearch ? '🌐 联网搜索已开启' : '🌐 联网搜索已关闭');
  }

  private toggleRerank() {
    this.rerankPref = { ...this.rerankPref, enabled: !this.rerankPref.enabled };
    this.saveRerankPref();
    this.showToast(this.rerankPref.enabled ? '🎯 端侧 Rerank 已开启（下次回答生效）' : '🎯 端侧 Rerank 已关闭');
  }

  private send() {
    const q = this.draft.trim();
    if (!q || this.streaming || !this.sessionId) return;

    const userBubble: UiBubble = {
      id: 'u-' + Date.now(),
      role: 'user',
      content: q,
      tools: [],
      references: [],
      streaming: false,
    };
    const assistantKey = 'a-' + Date.now();
    const placeholder: UiBubble = {
      id: assistantKey,
      role: 'assistant',
      content: '',
      tools: [],
      references: [],
      streaming: true,
    };
    this.bubbles = [...this.bubbles, userBubble, placeholder];
    this.draft = '';
    this.streaming = true;
    this.error = '';

    const settings = loadSettings();
    this._assistantMessageId = '';
    this.streamHandle = agentChatStream(
      this.sessionId,
      q,
      {
        agentId: settings.defaultAgentId || undefined,
        webSearchEnabled: this.webSearch,
        onAssistantMessageId: (id) => { this._assistantMessageId = id; },
        onFinish: () => this.finishStream(assistantKey),
      },
      (evt) => this.handleEvent(assistantKey, evt),
      (err) => {
        this.error = err.message;
        this.finishStream(assistantKey);
      },
    );
  }

  /** 流结束（正常/出错/取消）统一收尾 */
  private finishStream(assistantKey: string) {
    if (!this.streaming) return;
    this.streaming = false;
    this.bubbles = this.bubbles.map((b) =>
      b.id === assistantKey ? { ...b, streaming: false } : b
    );
  }

  private handleEvent(key: string, evt: AgentEvent) {
    const idx = this.bubbles.findIndex((b) => b.id === key);
    if (idx === -1) return;
    const cur = this.bubbles[idx];
    let updated = { ...cur };
    switch (evt.type) {
      case 'answer':
        updated.content = cur.content + (evt.content || '');
        if (evt.done) {
          updated.streaming = false;
          // 流结束 → 跑端侧 rerank（如果开启）
          this.maybeRerankInPlace(key, updated, evt, cur);
        }
        break;
      case 'thinking':
        updated.thinking = (cur.thinking || '') + (evt.content || '');
        break;
      case 'tool_call': {
        const name = (evt.data?.tool_name as string) || 'tool';
        updated.tools = [...cur.tools, { name, status: 'calling' }];
        break;
      }
      case 'tool_result': {
        const last = cur.tools[cur.tools.length - 1];
        if (last && last.status === 'calling') {
          updated.tools = cur.tools.map((t, i) =>
            i === cur.tools.length - 1
              ? { ...t, status: 'done', result: evt.content }
              : t
          );
        } else {
          updated.tools = [...cur.tools, { name: 'tool', status: 'done', result: evt.content }];
        }
        break;
      }
      case 'references': {
        const refs = (evt.data?.knowledge_references as any[]) || [];
        // 保存完整内容供端侧 rerank 使用（后端可能不返回 content，这里做兜底）
        updated.references = [
          ...cur.references,
          ...refs.map((r) => ({
            id: r.id || `${r.knowledge_id}#${r.chunk_index ?? 0}`,
            title: r.knowledge_title || 'Untitled',
            score: r.score,
            content: r.content || '',
          })),
        ];
        break;
      }
      case 'error':
        // 后端出错时会先发 complete 再发 error（客户端已做宽限处理，这里能收到）
        // 同一批可能重复发多条 error，只渲染第一条
        if (cur.errored) break;
        updated.errored = true;
        updated.content +=
          (updated.content ? '\n\n' : '') + '⚠️ ' + friendlyError(evt.content || '');
        updated.streaming = false;
        break;
      default:
        break;
    }
    const newBubbles = [...this.bubbles];
    newBubbles[idx] = updated;
    this.bubbles = newBubbles;
    this.requestUpdate();
  }

  private stop() {
    // 1) 本地中止流
    this.streamHandle?.cancel();
    this.streamHandle = null;
    this.streaming = false;
    this.bubbles = this.bubbles.map((b) =>
      b.streaming ? { ...b, streaming: false } : b
    );
    // 2) 通知后端停止生成（否则后端还在跑）
    const sid = this.sessionId;
    const mid = this._assistantMessageId;
    if (sid && mid) {
      stopGeneration(sid, mid).catch((e) =>
        console.warn('[chat] stopGeneration failed:', e)
      );
    }
    this.showToast('已停止生成');
  }

  /** 切换会话/离开页面时，取消正在进行的流 */
  private cancelStream() {
    if (this.streamHandle) {
      this.streamHandle.cancel();
      this.streamHandle = null;
    }
    if (this.streaming) {
      this.streaming = false;
      this.bubbles = this.bubbles.map((b) =>
        b.streaming ? { ...b, streaming: false } : b
      );
    }
  }

  /**
   * 端侧 rerank — 在流结束后调用，根据用户 toggle 决定是否启用
   * rerank 在 references 内容上做精排，结果回填到 bubble.references
   */
  private async maybeRerankInPlace(
    key: string,
    snapshot: UiBubble,
    evt: AgentEvent,
    prev: UiBubble
  ): Promise<void> {
    // 取出刚才 push 的 references（去重，按 id）
    const before = prev.references;
    const after = snapshot.references;
    const newRefs = after.slice(before.length);
    if (newRefs.length === 0) return;

    if (!this.rerankPref.enabled) {
      // 不开启 rerank：保留原顺序，仅更新 UI 状态
      this.patchBubble(key, snapshot);
      return;
    }

    // 构造 RerankCandidate
    const candidates: RerankCandidate[] = newRefs.map((r, idx) => ({
      id: r.id || `${idx}`,
      knowledge_title: r.title,
      content: r.content || '',
      score: r.score,
    }));

    // 找出本次问的 query（最近的 user bubble）
    const lastUser = [...this.bubbles].reverse().find((b) => b.role === 'user');
    const query = lastUser?.content || '';

    try {
      const { results: reranked, stats } = await doRerank(query, candidates, {
        topN: this.rerankPref.topN,
        forceFallback: this.rerankPref.forceFallback,
        timeoutMs: 3000,
      });
      const newRefsAfter: typeof newRefs = reranked.map((r) => ({
        id: r.id,
        title: r.knowledge_title || 'Untitled',
        score: r.score,
        content: r.content,
      }));
      // 拼接：保留旧 references，只把新的那一批换成 rerank 后顺序
      const merged = [...before, ...newRefsAfter];
      this.patchBubble(key, {
        ...snapshot,
        references: merged,
        rerankStats: stats,
      });
    } catch (e) {
      console.warn('[chat] rerank failed, keeping original order:', e);
      this.patchBubble(key, snapshot);
    }
  }

  private patchBubble(key: string, updated: UiBubble) {
    const idx = this.bubbles.findIndex((b) => b.id === key);
    if (idx === -1) return;
    const arr = [...this.bubbles];
    arr[idx] = updated;
    this.bubbles = arr;
  }

  render() {
    return html`
      <div style="display:flex;flex-direction:column;height:100%;background:var(--bg);position:relative;">
        ${this.error ? html`<div style="padding:10px 16px;background:color-mix(in srgb,var(--error) 10%,transparent);color:var(--error);font-size:13px;border-bottom:1px solid var(--border);">⚠️ ${this.error}</div>` : nothing}

        <!-- 顶部工具栏：联网 / Rerank（答复显示在这之下） -->
        <div class="chat-toolbar">
          <button class="chip ${this.webSearch ? 'active' : ''}" @click=${() => this.toggleWeb()}>
            🌐 联网${this.webSearch ? ' · 开' : ''}
          </button>
          <button class="chip ${this.rerankPref.enabled ? 'active' : ''}" @click=${() => this.toggleRerank()}>
            🎯 Rerank${this.rerankPref.enabled ? ' · 开' : ''}
          </button>
          <div style="flex:1;"></div>
          ${this.bubbles.length > 0 ? html`
            <span style="font-size:11px;color:var(--dim);">${this.bubbles.length} 条消息</span>
          ` : nothing}
        </div>

        <!-- 消息区 -->
        <div class="chat-body" id="chat-body">
          ${this.bubbles.length === 0
            ? html`<div class="empty"><div class="empty-icon">💬</div><div>开始一段新对话</div><div style="font-size:12px;">Enter 发送 · Shift+Enter 换行</div></div>`
            : this.bubbles.map((b) => this.renderBubble(b))}
        </div>

        <!-- 输入区 -->
        <div class="composer">
          <div class="composer-input">
            <textarea
              rows="3"
              placeholder="问点什么…"
              .value=${this.draft}
              @input=${this.handleInput}
              @keydown=${this.handleKeyDown}
              ?disabled=${this.streaming}
            ></textarea>
            ${this.streaming
              ? html`<button class="send-btn stop" @click=${() => this.stop()} title="停止">■</button>`
              : html`<button class="send-btn" ?disabled=${!this.draft.trim()} @click=${() => this.send()} title="发送">➤</button>`}
          </div>
        </div>

        ${this.toast ? html`<div class="toast">${this.toast}</div>` : nothing}
      </div>
    `;
  }

  /**
   * 把内容按 \n\n 分段，每段渲染为 <p>
   * 流式输出时只在最后一段后挂光标
   */
  private renderParagraphs(content: string, streaming: boolean) {
    if (!content && !streaming) return nothing;
    const paragraphs = content.split(/\n{2,}/);
    return html`${paragraphs.map((para, i) => html`
      <p style="margin: 0 0 ${i < paragraphs.length - 1 ? '10px' : '0'}; white-space: pre-wrap; word-wrap: break-word; line-height: 1.65;">${para}${streaming && i === paragraphs.length - 1 ? html`<span class="cursor"></span>` : nothing}</p>
    `)}`;
  }

  private renderBubble(b: UiBubble) {
    if (b.role === 'user') {
      // 用户消息按段渲染（保留换行结构）
      return html`<div class="bubble user">${this.renderParagraphs(b.content, false)}</div>`;
    }
    return html`
      <div class="bubble-row">
        ${b.thinking ? html`<div class="bubble system">💭 ${b.thinking}</div>` : nothing}
        ${b.tools.map((t) =>
          t.status === 'calling'
            ? html`<div class="bubble system">🔧 ${t.name} 调用中…</div>`
            : html`<div class="bubble system">🔧 ${t.name}: ${t.result || '完成'}</div>`
        )}
        ${(b.content || b.streaming)
          ? html`<div class="bubble assistant">${this.renderParagraphs(b.content, b.streaming)}</div>`
          : nothing}
        ${b.references.length > 0 ? html`
          <div class="refs">
            <div class="refs-title">
              📎 References
              ${b.rerankStats ? html`
                <span style="font-weight:400;color:var(--fg-3);font-size:11px;margin-left:auto;">
                  ${b.rerankStats.level}${b.rerankStats.cacheHit ? ' (cached)' : ''} · ${b.rerankStats.durationMs}ms
                </span>
              ` : nothing}
            </div>
            ${b.references.slice(0, 5).map((r, i) => html`
              <div class="refs-item">
                ${i + 1}. ${r.title}
                <span style="color:var(--fg-3);font-size:11px;"> · ${(r.score ?? 0).toFixed(2)}</span>
              </div>
            `)}
          </div>
        ` : nothing}
      </div>
    `;
  }
}