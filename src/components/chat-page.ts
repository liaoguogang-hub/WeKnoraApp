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
  type AgentEvent, type Message, type StreamFinishInfo, type StreamHandle,
} from '../lib/weknora-client';
import {
  rerank as doRerank, preloadCrossEncoder, getCrossEncoderState,
  type RerankCandidate, type RerankStats,
} from '../lib/reranker';
import { resolveAgentForSession } from '../lib/session-agent';

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

/** 把 rerank 的档位翻译成人话 —— 用户要看得出这次到底有没有真的用上神经网络 */
function rerankLevelLabel(level: RerankStats['level']): string {
  switch (level) {
    case 'cross-encoder': return '🎯 神经网络精排';
    case 'bm25-rescore': return '🎯 关键词精排(BM25)';
    default: return '🎯 未精排';
  }
}

/**
 * 把 **fetch 层**的网络错误翻译成用户能懂的话。
 *
 * ⚠️ 和 friendlyError() 不同：那个处理的是「服务端把错误当事件发回来」，
 *    这个处理的是「请求根本没到服务端」（Failed to fetch / 连接被掐）。
 *    两者混为一谈正是之前那句误导性文案的成因。
 */
function friendlyNetworkError(raw: string): string {
  const s = raw || '';
  if (/failed to fetch|networkerror|load failed|err_(connection|name|internet|address|timed_out|network)/i.test(s)) {
    return '连不上 WeKnora 服务端（请求没发出去）。已自动重试仍未成功 —— 请检查手机网络，或到「设置」确认服务地址后重新发送。';
  }
  return s;
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
  /** 流式被中断（没收到终止事件），内容可能不完整 */
  truncated?: boolean;
  /** 正在从服务端把完整内容捞回来 */
  reconciling?: boolean;
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
  /** 本轮提问的原文（网络失败自动重试时要用） */
  private _lastQuery = '';
  /** 本轮提问的开始时间 —— 用于把「服务端取回的答案」限定在本轮，避免拿错上一轮 */
  private _turnStartedAt = 0;
  /** 已经为本轮重试过一次的 assistantKey（只重试一次） */
  private _retriedFor = '';
  /** cross-encoder 的真实状态，供 UI 显示是否已就绪 */
  @state() private ceState: 'idle' | 'loading' | 'ready' | 'failed' = getCrossEncoderState().state;
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
    // Rerank 开着就顺手预热模型（首次约 20MB，走 hf-mirror）
    if (this.rerankPref.enabled) {
      void preloadCrossEncoder().then(() => { this.ceState = getCrossEncoderState().state; });
    }
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
    if (!this.rerankPref.enabled) {
      this.showToast('🎯 端侧 Rerank 已关闭');
      return;
    }
    this.ceState = 'loading';
    this.showToast('🎯 Rerank 已开启，正在准备模型…');
    // 预热：不预热的话第一次精排必然撞上加载超时，然后一路退化成 BM25
    void preloadCrossEncoder().then((ok) => {
      this.ceState = getCrossEncoderState().state;
      this.showToast(ok
        ? '🎯 端侧神经网络模型已就绪'
        : '🎯 已启用关键词精排（端侧神经网络模型在当前网络不可用）');
    });
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

    this._lastQuery = q;
    this._turnStartedAt = Date.now();
    this._retriedFor = '';
    this.startStream(assistantKey, q);
  }

  /** 真正发起一次流式请求。自动重试时会用同一个 assistantKey 再调一次。 */
  private startStream(assistantKey: string, query: string) {
    const settings = loadSettings();
    // 「一个会话固定一个 agent」：优先用该会话的绑定，没绑定才回落到全局默认
    const sessionAgentId = resolveAgentForSession(this.sessionId, settings.defaultAgentId);
    this._assistantMessageId = '';
    this.streaming = true;
    // 清掉上一轮遗留的错误提示：自动重试成功时它不应该继续挂在那里
    this.error = '';
    this.streamHandle = agentChatStream(
      this.sessionId,
      query,
      {
        agentId: sessionAgentId || undefined,
        webSearchEnabled: this.webSearch,
        onAssistantMessageId: (id) => { this._assistantMessageId = id; },
        onFinish: (info) => this.finishStream(assistantKey, info),
      },
      (evt) => this.handleEvent(assistantKey, evt),
      // 只记录真实错误，**不在这里收尾** —— 否则 finish() 里的兜底文案会把
      // 它覆盖掉，用户看到的就是「服务端没有返回任何内容」这种误导性提示。
      // 收尾统一由 onFinish 负责。
      (err) => { this.error = friendlyNetworkError(err.message); },
    );
  }

  /** 流结束（正常/出错/取消）统一收尾 */
  private finishStream(assistantKey: string, info?: StreamFinishInfo) {
    if (!this.streaming) return;

    const idx0 = this.bubbles.findIndex((b) => b.id === assistantKey);
    const cur = idx0 === -1 ? null : this.bubbles[idx0];
    const gotSomething =
      !!cur && ((cur.content || '').length > 0 || (cur.tools || []).length > 0 || !!cur.thinking);

    // ① 请求在**网络层**就失败了（fetch 抛错：DNS/连接/预检被掐），且一个字都没收到
    //    → 自动重试一次。这种失败请求根本没到服务端，重试是安全且有效的。
    if (info?.reason === 'error' && !gotSomething && this._retriedFor !== assistantKey) {
      this._retriedFor = assistantKey;
      this.showToast('网络中断，正在自动重试…');
      const q = this._lastQuery;
      const sid = this.sessionId;
      // ⚠️ 这里**不能**用 `!this.streaming` 当守卫：为了保持光标闪烁，上面这段
      //    故意没有把 streaming 置回 false，那样写会让重试永远不触发（实测踩过）。
      setTimeout(() => {
        const alive = this.bubbles.findIndex((b) => b.id === assistantKey) !== -1;
        if (this.sessionId !== sid || !alive) {
          this.streaming = false;   // 场景已经变了，别把 UI 卡在「生成中」
          return;
        }
        this.startStream(assistantKey, q);
      }, 1500);
      return; // 保持 streaming 状态，等重试接管
    }

    this.streaming = false;
    this.bubbles = this.bubbles.map((b) =>
      b.id === assistantKey ? { ...b, streaming: false } : b
    );
    // ⚠️ rerank 必须等**整条流结束**再做，不能挂在 answer.done 上：
    //    answer.done 之后还有 600ms 宽限期可能再来一条 error，
    //    那时 rerank 若已拿旧快照回填，会把刚写上去的错误提示擦掉。
    void this.runRerank(assistantKey);

    // ② 没收到终止事件 ⇒ 这条流是被掐断的（超时/断线），而服务端多半还在生成，
    //    且它最终会把完整答案落库。起个后台任务把答案捞回来。
    const interruptedByUser = info?.reason === 'cancelled-by-user' || info?.reason === 'aborted';
    if (info && !info.sawTerminal && !interruptedByUser && gotSomething) {
      this.patchTruncated(assistantKey, true, true);
      void this.reconcileFromServer(assistantKey);
      return;
    }

    // ③ 回合干净结束、但气泡里没留下正文（例如最后一个 iteration 只发了工具调用），
    //    而服务端可能存了内容 —— 这种情况也去取一次。reconcileFromServer 若判定
    //    本轮在服务端没有记录会很快放弃，不会产生可见噪音。
    const idxNow = this.bubbles.findIndex((b) => b.id === assistantKey);
    const contentEmpty = idxNow === -1 || !(this.bubbles[idxNow].content || '').trim();
    if (info?.sawTerminal && contentEmpty && !interruptedByUser) {
      void this.reconcileFromServer(assistantKey);
    }
  }

  /** 标记/清除「回答可能不完整」，并控制是否显示「正在取回」 */
  private patchTruncated(key: string, truncated: boolean, reconciling: boolean) {
    const idx = this.bubbles.findIndex((b) => b.id === key);
    if (idx === -1) return;
    const arr = [...this.bubbles];
    if (arr[idx].truncated === truncated && arr[idx].reconciling === reconciling) return;
    arr[idx] = { ...arr[idx], truncated, reconciling };
    this.bubbles = arr;
  }

  /**
   * 从服务端把这次回答的完整内容取回来。
   *
   * 依据：WeKnora 是「先建 assistant 消息行、边生成边更新」，客户端中断并不影响
   * 服务端最后把完整答案落库。真机实测：客户端只收到 65 字，服务端存了 6574 字。
   * 所以中断后轮询 /messages/load 就能把答案补回来。
   */
  private async reconcileFromServer(key: string) {
    const sid = this.sessionId;
    // ⚠️ 必须把「服务端那条消息」限定在**本轮**，否则会拿错：
    //    如果这次请求压根没到服务端（例如 fetch 直接失败），消息表里最新的一条
    //    assistant 其实是**上一轮**的答案 —— 直接用它会把旧答案填进新气泡。
    //    匹配依据：优先用流里报过的 assistant_message_id；否则用 created_at 落在
    //    本轮开始之后的最后一条 assistant。
    const turnId = this._assistantMessageId;
    const turnStart = this._turnStartedAt ? this._turnStartedAt - 5000 : 0;

    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 6000));
      if (this.sessionId !== sid) return;                 // 用户已切走
      const idx = this.bubbles.findIndex((b) => b.id === key);
      if (idx === -1) return;                             // 气泡已被替换/清空
      const cur = this.bubbles[idx];
      if (cur.streaming) return;                          // 新一轮已经开始

      let msgs: Message[] = [];
      try {
        msgs = await loadMessages(sid, 10);
      } catch {
        continue;                                         // 网络还没恢复，下一轮再试
      }

      const assistants = msgs.filter((m) => m.role === 'assistant');
      const mineById = turnId ? assistants.find((m) => m.id === turnId) : undefined;
      const mineByTime = turnStart
        ? [...assistants].reverse().find((m) => (Date.parse(m.created_at || '') || 0) >= turnStart)
        : undefined;
      const mine = mineById || mineByTime;

      if (!mine) {
        // 本轮在服务端还没有任何记录。前几轮先等（服务端可能正要建行），
        // 若一直没等到，说明这次请求根本没到服务端 —— 放弃，不要动气泡。
        if (attempt >= 2) { this.patchTruncated(key, false, false); return; }
        continue;
      }

      const serverText = String(mine.content || '').trim();
      if (!serverText) continue;                          // 行已建、内容还在生成
      if (serverText.length <= (cur.content || '').length) {
        this.patchTruncated(key, false, false);           // 我们手上的不比服务端少
        return;
      }

      const now = this.bubbles.findIndex((b) => b.id === key);
      if (now === -1) return;
      this.patchBubble(key, {
        ...this.bubbles[now],
        content: serverText,
        truncated: false,
        reconciling: false,
        errored: false,
      });
      if (this.error) this.error = '';                    // 之前的超时提示已无意义
      this.showToast('已从服务端取回完整回答');
      return;
    }
    // 到点还没拿到 —— 保留「可能不完整」标记，但别再显示「正在取回」
    this.patchTruncated(key, true, false);
  }

  private handleEvent(key: string, evt: AgentEvent) {
    const idx = this.bubbles.findIndex((b) => b.id === key);
    if (idx === -1) return;
    const cur = this.bubbles[idx];
    let updated = { ...cur };
    switch (evt.type) {
      case 'answer':
        updated.content = cur.content + (evt.content || '');
        if (evt.done) updated.streaming = false;
        break;
      case 'thinking':
        updated.thinking = (cur.thinking || '') + (evt.content || '');
        break;
      case 'tool_call': {
        const name = (evt.data?.tool_name as string) || 'tool';
        // ⚠️ 收到 tool_call 意味着：当前累积的 content 属于**本轮 iteration 的过程口述**
        //    （「我来检索一下…让我再深入阅读某某章节…」），而不是最终答案。
        //
        //    服务端只保存**最后一个 iteration 的输出**（前面的口述落在 agent_steps 的
        //    thought 里）。真机实测：界面 6715 字 vs 服务端 6520 字，多出来的 195 字
        //    正是这些口述 —— 同一轮回答，实时看到的比重开会话后多一段。
        //
        //    所以这里把它从 content 移到 thinking 区：既保留（用户仍看得到 agent 的
        //    进度），又不再混进答案，实时与重开后的内容就此一致。
        const narration = (updated.content || '').trim();
        if (narration) {
          updated.thinking = cur.thinking ? `${cur.thinking}\n\n${narration}` : narration;
          updated.content = '';
        }
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
   * 端侧 rerank —— 在**整条流结束之后**执行。
   *
   * 旧实现有两个问题，导致它一次都没真正跑过：
   *   ① 挂在 answer.done 上（而不是流结束），紧跟其后的 error 会被旧快照回填擦掉；
   *   ② 用 `snapshot.references.slice(prev.references.length)` 取「本回合新增的引用」，
   *      但 snapshot 是 prev 的**浅拷贝**，两者 references 是同一个数组，
   *      于是 slice(len) 恒为 []，函数每次都在第一行 return —— rerank 从未执行。
   *
   * 现在直接对「该气泡当前的引用全集」做精排：一个气泡就是一个回合，全集即本回合引用。
   */
  private async runRerank(key: string): Promise<void> {
    if (!this.rerankPref.enabled) return;

    const idx = this.bubbles.findIndex((b) => b.id === key);
    if (idx === -1) return;
    const target = this.bubbles[idx];
    if (target.references.length === 0) return;

    // query = 该气泡之前最近的一条用户消息
    let query = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (this.bubbles[i].role === 'user') { query = this.bubbles[i].content; break; }
    }
    if (!query.trim()) return;

    const candidates: RerankCandidate[] = target.references.map((r, i) => ({
      id: r.id || `${key}#${i}`,
      knowledge_title: r.title,
      content: r.content || '',
      score: r.score,
    }));

    try {
      const { results, stats } = await doRerank(query, candidates, {
        topN: this.rerankPref.topN,
        forceFallback: this.rerankPref.forceFallback,
        timeoutMs: 5000,
      });

      // ⚠️ 回填时**重新取当前气泡**：await 期间它可能已经追加了 error 文案。
      //    只覆盖 references / rerankStats，绝不回写整个旧快照。
      const j = this.bubbles.findIndex((b) => b.id === key);
      if (j === -1) return;
      const now = this.bubbles[j];
      const reranked = results.map((r) => ({
        id: r.id,
        title: r.knowledge_title || 'Untitled',
        score: r.score,
        content: r.content,
      }));
      this.patchBubble(key, {
        ...now,
        references: reranked.length ? reranked : now.references,
        rerankStats: stats,
      });
    } catch (e) {
      // 失败就保持服务端给的原始顺序，不动气泡
      console.warn('[chat] rerank failed, keeping original order:', e);
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
        ${b.truncated ? html`
          <div class="bubble system">⚠️ 流式连接中断，回答可能不完整${b.reconciling ? ' —— 正在从服务端取回完整内容…' : ''}</div>
        ` : nothing}
        ${b.references.length > 0 ? html`
          <div class="refs">
            <div class="refs-title">
              📎 References
              ${b.rerankStats ? html`
                <span
                  style="font-weight:400;color:var(--fg-3);font-size:11px;margin-left:auto;"
                  title=${`rerank level: ${b.rerankStats.level}`}
                >
                  ${rerankLevelLabel(b.rerankStats.level)}${b.rerankStats.cacheHit ? ' · 缓存' : ''} · ${b.rerankStats.durationMs}ms
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