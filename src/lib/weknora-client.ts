/**
 * WeKnora REST API 客户端
 *
 * 能力：
 *  - Settings 持久化（baseUrl / apiKey / agentId / webSearch）
 *  - Session CRUD + pin
 *  - Message 加载
 *  - Agent / KnowledgeBase 列表
 *  - Agent 流式问答（SSE 解析）
 */

import { CapacitorHttp } from '@capacitor/core';

// ============ Types ============

export interface WeKnoraSettings {
  baseUrl: string;
  apiKey: string;
  defaultAgentId: string;
  webSearchEnabled: boolean;
}

export interface Session {
  id: string;
  title: string;
  description?: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  agent_id?: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  is_completed: boolean;
  knowledge_references?: KnowledgeRef[];
  agent_steps?: AgentStep[];
  created_at: string;
}

export interface KnowledgeRef {
  id: string;
  content?: string;
  knowledge_title?: string;
  knowledge_id?: string;
  score: number;
}

export interface AgentStep {
  type: string;
  content?: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  is_builtin: boolean;
  config: AgentConfig;
}

export interface AgentConfig {
  agent_mode: string;
  web_search_enabled: boolean;
  multi_turn_enabled: boolean;
  history_turns: number;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  type: string;
  knowledge_count: number;
  is_pinned: boolean;
}

export interface AgentEvent {
  type: 'agent_query' | 'thinking' | 'tool_call' | 'tool_result'
      | 'references' | 'answer' | 'session_title' | 'complete' | 'error' | 'unknown';
  content?: string;
  done?: boolean;
  data?: Record<string, unknown>;
}

// ============ Settings Store ============

const SETTINGS_KEY = 'weknora-settings';

const DEFAULT_SETTINGS: WeKnoraSettings = {
  baseUrl: '',
  apiKey: '',
  defaultAgentId: 'builtin-smart-reasoning',
  webSearchEnabled: true,
};

export function loadSettings(): WeKnoraSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: WeKnoraSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function isConfigured(): boolean {
  const s = loadSettings();
  return s.baseUrl.trim() !== '' && s.apiKey.trim() !== '';
}

// ============ HTTP Helper ============

interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * 统一的 API 请求。
 *
 * ⚠️ 不再做任何「智能解包」——WeKnora 所有接口都返回 {data: ..., success: true} 包装，
 *    由各调用方显式取 `.data`。之前按「键数 ≤3 就解包」的启发式会让
 *    /messages/load（2 键）和 /agents（3 键）被错误解包，导致消息与 Agent 列表恒为空。
 */
async function api<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { baseUrl, apiKey } = loadSettings();
  if (!baseUrl || !apiKey) {
    throw new Error('未配置 WeKnora baseUrl / API Key，请先到「设置」填写');
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1${path}`;
  const init: RequestInit = {
    method: opts.method || 'GET',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  console.log('[weknora]', opts.method || 'GET', path);
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    console.error('[weknora] fetch error', path, (e as Error).message);
    throw new Error('网络请求失败: ' + (e as Error).message);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('[weknora] error', path, resp.status, text.slice(0, 200));
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error?.message || j.error || msg;
    } catch {}
    throw new Error(`${msg} [${resp.status}]`);
  }
  return (await resp.json()) as T;
}

/** 从 {data: T} 包装里安全取 data */
function unwrap<T>(resp: any): T {
  if (resp && typeof resp === 'object' && 'data' in resp) return resp.data as T;
  return resp as T;
}

// ============ Session API ============

export async function listSessions(opts: { keyword?: string; pinnedOnly?: boolean } = {}): Promise<Session[]> {
  const params = new URLSearchParams();
  if (opts.keyword) params.set('keyword', opts.keyword);
  params.set('page', '1');
  params.set('page_size', '50');
  const resp = await api<any>(`/sessions?${params.toString()}`);
  let sessions: Session[] = Array.isArray(resp?.data) ? resp.data : [];
  if (opts.pinnedOnly) sessions = sessions.filter((s) => s.is_pinned);
  return sessions;
}

export async function createSession(title?: string | null, agentId?: string): Promise<Session> {
  const resp = await api<any>('/sessions', {
    method: 'POST',
    body: { title: title || undefined, agent_id: agentId || undefined },
  });
  return unwrap<Session>(resp);
}

export async function deleteSession(id: string): Promise<void> {
  await api(`/sessions/${id}`, { method: 'DELETE' });
}

export async function pinSession(id: string): Promise<{ is_pinned: boolean }> {
  const resp = await api<any>(`/sessions/${id}/pin`, { method: 'POST' });
  return unwrap(resp) ?? { is_pinned: false };
}

export async function stopGeneration(sessionId: string, messageId: string): Promise<void> {
  await api(`/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: { message_id: messageId },
  });
}

// ============ Message API ============

export async function loadMessages(sessionId: string, limit = 50): Promise<Message[]> {
  const resp = await api<any>(`/messages/${sessionId}/load?limit=${limit}`);
  const list = unwrap<Message[]>(resp);
  return Array.isArray(list) ? list : [];
}

// ============ Agent API ============

export async function listAgents(): Promise<Agent[]> {
  const resp = await api<any>('/agents');
  const list = unwrap<Agent[]>(resp);
  console.log('[weknora] agents raw keys:', Object.keys(resp || {}), '→ parsed', Array.isArray(list) ? list.length : typeof list);
  return Array.isArray(list) ? list : [];
}

// ============ Knowledge Base API ============

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  const resp = await api<any>('/knowledge-bases');
  const list = unwrap<KnowledgeBase[]>(resp);
  return Array.isArray(list) ? list : [];
}

export async function importUrlToKB(kbId: string, url: string): Promise<void> {
  await api(`/knowledge-bases/${kbId}/knowledge/url`, {
    method: 'POST',
    body: { url, enable_multimodel: false },
  });
}

// ============ Knowledge (inside KB) API ============

export interface KnowledgeFolder {
  name: string;
  path: string;
  children?: KnowledgeFolder[];
  is_folder: boolean;
}

export interface Knowledge {
  id: string;
  title: string;
  description?: string;
  file_name?: string;
  file_extension?: string;
  file_size?: number;
  folder_path?: string;
  parse_status?: string; // pending / processing / completed / failed
  chunk_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface KnowledgeDetail extends Knowledge {
  content?: string;
  metadata?: Record<string, any>;
  tags?: string[];
}

export async function listKnowledgeFolders(kbId: string): Promise<KnowledgeFolder[]> {
  return api<KnowledgeFolder[]>(`/knowledge-bases/${kbId}/knowledge/folders`);
}

export async function listKnowledge(
  kbId: string,
  opts: { keyword?: string; folder?: string; page?: number; pageSize?: number } = {}
): Promise<{ items: Knowledge[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.keyword) params.set('keyword', opts.keyword);
  if (opts.folder) params.set('folder', opts.folder);
  params.set('page', String(opts.page || 1));
  params.set('page_size', String(opts.pageSize || 50));
  const resp = await api<any>(
    `/knowledge-bases/${kbId}/knowledge?${params.toString()}`
  );
  const items = Array.isArray(resp?.data) ? resp.data : [];
  return { items, total: resp?.total || items.length };
}

export async function getKnowledge(id: string): Promise<KnowledgeDetail> {
  const resp = await api<any>(`/knowledge/${id}`);
  return unwrap<KnowledgeDetail>(resp);
}

export async function getKnowledgePreview(id: string): Promise<Blob> {
  const { baseUrl, apiKey } = loadSettings();
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/knowledge/${id}/preview`;
  const resp = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.blob();
}

export async function getKnowledgeDownloadUrl(id: string): Promise<string> {
  const { baseUrl, apiKey } = loadSettings();
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/knowledge/${id}/download?_t=${Date.now()}&_k=${apiKey}`;
}

// ============ Agent Stream (SSE) ============

export interface StreamHandle {
  cancel: () => void;
}

/**
 * 调用 /agent-chat/:sessionId，按 SSE 流式产出 AgentEvent。
 *
 * ⚠️ 重要：WeKnora 的 SSE 在发完终止事件后**不会主动关闭连接**，
 *    所以不能只依赖 reader.read() 的 done；必须识别终止事件主动收尾。
 *
 * 终止判定（顺序很关键，error 优先）：
 *   1. response_type === 'error'  → 出错结束（服务端出错时会先发 complete 再发 error，
 *      所以 complete 必须留宽限期，不能立即收尾，否则错误被吞掉）
 *   2. response_type === 'complete' → 显式结束，留 600ms 宽限等随后的 error
 *   3. response_type === 'answer' && done === true → 正常结束，留 600ms 宽限
 *   4. 空闲超时（默认 25s 无数据）→ 兜底结束
 *   5. 全程没有任何答案内容也没有 error → 视为失败并回调 onError，
 *      避免用户只看到一个空白气泡
 */
export function agentChatStream(
  sessionId: string,
  query: string,
  opts: {
    agentId?: string;
    webSearchEnabled?: boolean;
    knowledgeBaseIds?: string[];
    idleTimeoutMs?: number;
    onFinish?: () => void;
    onAssistantMessageId?: (id: string) => void;
  } = {},
  onEvent: (e: AgentEvent) => void,
  onError?: (err: Error) => void,
): StreamHandle {
  const ctrl = new AbortController();
  const { baseUrl, apiKey } = loadSettings();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 25000;

  let finished = false;
  let idleTimer: any = null;
  let graceTimer: any = null;
  // 是否收到过「有效答案」和「明确错误」——用来兜底判断本次是否其实是失败
  let sawAnswer = false;
  let sawError = false;

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(graceTimer);
    console.log('[weknora] stream finished:', reason, 'sawAnswer=', sawAnswer, 'sawError=', sawError);
    // 主动断开，避免连接泄漏（后端不会自己关）
    try { ctrl.abort(); } catch {}
    // ⚠️ 兜底：既没有答案、也没有明确错误 → 必须报出来，
    //    否则用户只会看到一个空白气泡，完全不知道发生了什么。
    //    排除用户主动取消（那是预期行为，不该弹错误）。
    const userCancelled = reason === 'cancelled-by-user' || reason === 'not-configured';
    if (!sawAnswer && !sawError && !userCancelled) {
      onError?.(new Error(
        reason === 'idle-timeout'
          ? '服务端长时间没有返回内容，已超时中止。请重试。'
          : '服务端没有返回任何内容（通常是模型额度不足或后端异常），请稍后重试。'
      ));
    }
    opts.onFinish?.();
  };

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.warn('[weknora] stream idle timeout, forcing finish');
      finish('idle-timeout');
    }, idleTimeoutMs);
  };

  const run = async () => {
    if (!baseUrl || !apiKey) {
      onError?.(new Error('未配置 WeKnora baseUrl / apiKey'));
      finish('not-configured');
      return;
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/agent-chat/${sessionId}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          query,
          agent_enabled: true,
          agent_id: opts.agentId || undefined,
          web_search_enabled: opts.webSearchEnabled ?? false,
          knowledge_base_ids: opts.knowledgeBaseIds?.length ? opts.knowledgeBaseIds : undefined,
          channel: 'android',
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      resetIdle();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          finish('server-closed');
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.substring(0, idx);
          buffer = buffer.substring(idx + 2);

          let eventType = 'message';
          let dataLine = '';
          for (const line of block.split('\n')) {
            const l = line.trimStart();
            if (l.startsWith('event:')) eventType = l.substring(6).trim();
            else if (l.startsWith('data:')) dataLine += l.substring(5).trim();
          }
          if (!dataLine) continue;

          try {
            const payload = JSON.parse(dataLine);
            const rtype = (payload.response_type as string) || '';
            // 记下 assistant_message_id，供 /stop 使用
            const amid = payload.assistant_message_id || payload.data?.assistant_message_id;
            if (amid) opts.onAssistantMessageId?.(amid);

            const evt: AgentEvent = {
              type: (rtype as AgentEvent['type']) || 'unknown',
              content: payload.content || '',
              done: payload.done,
              data: payload.data || payload.knowledge_references
                ? {
                    ...(payload.data || {}),
                    ...(payload.knowledge_references ? { knowledge_references: payload.knowledge_references } : {}),
                  }
                : undefined,
            };
            onEvent(evt);
            resetIdle();

            if (rtype === 'answer' && evt.content) sawAnswer = true;
            if (rtype === 'error') sawError = true;

            // —— 终止判定 ——
            // ⚠️ 顺序至关重要：WeKnora 出错时会先发 complete、1ms 后再发 error。
            //    所以 complete 不能立即收尾，必须留一段宽限期等后面的 error，
            //    否则错误会被吞掉，用户只看到空白回复。
            // 1) error：优先，且给一点点缓冲把同一批的多条 error 收全
            if (rtype === 'error' || eventType === 'error') {
              clearTimeout(graceTimer);
              graceTimer = setTimeout(() => finish('error-event'), 300);
              continue;
            }
            // 2) complete：留 600ms 宽限，等可能紧跟其后的 error
            if (rtype === 'complete' || eventType === 'complete') {
              clearTimeout(graceTimer);
              graceTimer = setTimeout(() => finish('complete-event'), 600);
              continue;
            }
            // 3) answer 的最后一帧（done=true）→ 留 600ms 宽限期收尾
            if (rtype === 'answer' && payload.done === true) {
              clearTimeout(graceTimer);
              graceTimer = setTimeout(() => finish('answer-done'), 600);
            }
          } catch (parseErr) {
            console.warn('[weknora] SSE parse error:', parseErr, dataLine);
          }
        }
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        // 主动 abort（正常收尾或被用户停止）
        finish('aborted');
        return;
      }
      console.error('[weknora] stream error:', e);
      onError?.(e);
      finish('error');
    }
  };

  run();

  return {
    cancel: () => {
      finish('cancelled-by-user');
    },
  };
}