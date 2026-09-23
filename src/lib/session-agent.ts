/**
 * 「一个会话固定一个 agent」的本地绑定。
 *
 * ⚠️ 为什么绑定只能放在客户端：
 *    WeKnora 后端**不持久化会话的 agent**。真机实测：
 *      - POST /api/v1/sessions 带 agent_id 也会被丢弃
 *      - 读回来只有 id / title / description / tenant_id / user_id /
 *        is_pinned / created_at / updated_at / deleted_at
 *    所以 agent 只能按 sessionId 记在本地，发消息时当作 /agent-chat 的
 *    请求体 agent_id 传上去。
 *
 * 语义：
 *   - 新建会话   → 取「设置 → Default Agent」作为初始绑定
 *   - 老会话     → 没有记录时回落到 Default Agent，行为与升级前完全一致
 *   - 会话内切换 → 只影响该会话后续的消息，**不动全局默认值**
 */

const MAP_KEY = 'weknora-session-agents';

type AgentMap = Record<string, string>;

function readMap(): AgentMap {
  try {
    const raw = localStorage.getItem(MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AgentMap) : {};
  } catch {
    // 存储损坏 / 隐私模式：当作没有绑定，功能降级为「只用默认 agent」
    return {};
  }
}

function writeMap(m: AgentMap): void {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(m));
  } catch {
    // 配额满 / 隐私模式：忽略，不因为记不住绑定就打断对话
  }
}

/** 该会话绑定的 agentId；没绑过返回 ''（调用方负责回落到默认值） */
export function getBoundAgent(sessionId: string): string {
  if (!sessionId) return '';
  return readMap()[sessionId] || '';
}

/** 把 agent 绑到某个会话上 */
export function bindAgent(sessionId: string, agentId: string): void {
  if (!sessionId || !agentId) return;
  const m = readMap();
  if (m[sessionId] === agentId) return;
  m[sessionId] = agentId;
  writeMap(m);
}

/** 会话被删除时清掉绑定，避免映射无限增长 */
export function unbindAgent(sessionId: string): void {
  if (!sessionId) return;
  const m = readMap();
  if (!(sessionId in m)) return;
  delete m[sessionId];
  writeMap(m);
}

/**
 * 决定「这次请求该用哪个 agent」。
 * 会话有绑定就用绑定，否则用全局默认 —— 保证升级前建的会话行为不变。
 */
export function resolveAgentForSession(sessionId: string, defaultAgentId: string): string {
  return getBoundAgent(sessionId) || defaultAgentId || '';
}
