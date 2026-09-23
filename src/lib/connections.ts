/**
 * 命名连接（Connection）的存储与切换。
 *
 * 背景：原先「设置 → 连接 WeKnora」只有一对 baseUrl / apiKey 输入框，换一个
 * 服务器就得把地址和密钥重新敲一遍，也无法在多个 WeKnora（各自带自己的知识库）
 * 之间快速切换。这里引入「命名连接」：
 *
 *   - 每个连接有 name / baseUrl / apiKey（可选 defaultAgentId），存在本地
 *   - 同一时刻只有一个「生效中」的连接，它的值会被写进 weknora-settings
 *     （App 其余部分只读 weknora-settings，不需要改动）
 *   - 首次使用时会把现有 weknora-settings 自动登记成一个连接，避免列表是空的
 *
 * ⚠️ API Key 明文存在 WebView 的 localStorage 里，与既有行为一致（卸载 App 会丢）。
 */

import { loadSettings, saveSettings } from './weknora-client';

export interface Connection {
  /** 稳定 id，不用 name（名字可以改） */
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultAgentId?: string;
  updatedAt: number;
}

const LIST_KEY = 'weknora-connections';
const ACTIVE_KEY = 'weknora-active-connection';

function readList(): Connection[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as Connection[]).filter((c) => c && c.id && c.name) : [];
  } catch {
    return [];
  }
}

function writeList(list: Connection[]): void {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    /* 配额/隐私模式：忽略，不影响当前这次会话使用 */
  }
}

function newId(): string {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/** 从 URL 里取一个可读的短名，用于自动命名 */
export function autoName(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').slice(0, 24) || '未命名连接';
  }
}

export function getActiveId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) || '';
  } catch {
    return '';
  }
}

export function setActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * 列出所有连接。若列表为空，用当前 weknora-settings 自动登记一条，
 * 保证老用户升级后不至于「一个连接都没有」。
 */
export function listConnections(): Connection[] {
  let list = readList();
  if (list.length === 0) {
    const s = loadSettings();
    if (s.baseUrl && s.apiKey) {
      const seeded: Connection = {
        id: newId(),
        name: autoName(s.baseUrl),
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        defaultAgentId: s.defaultAgentId || undefined,
        updatedAt: Date.now(),
      };
      list = [seeded];
      writeList(list);
      setActiveId(seeded.id);
    }
  }
  return list;
}

export function findConnection(id: string): Connection | undefined {
  return readList().find((c) => c.id === id);
}

/** 找与给定地址+密钥完全相同的连接（用于「保存当前」时判断是新建还是更新） */
export function findByEndpoint(baseUrl: string, apiKey: string): Connection | undefined {
  const b = (baseUrl || '').replace(/\/+$/, '');
  return readList().find((c) => c.baseUrl.replace(/\/+$/, '') === b && c.apiKey === apiKey);
}

/**
 * 新增或更新一个连接。
 * @param existingId 传了就是更新，否则新建
 */
export function upsertConnection(
  input: { name: string; baseUrl: string; apiKey: string; defaultAgentId?: string },
  existingId?: string
): Connection {
  const list = readList();
  const clean = {
    name: input.name.trim() || autoName(input.baseUrl),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey.trim(),
    defaultAgentId: input.defaultAgentId,
  };
  const idx = existingId ? list.findIndex((c) => c.id === existingId) : -1;
  if (idx >= 0) {
    const merged: Connection = { ...list[idx], ...clean, updatedAt: Date.now() };
    list[idx] = merged;
    writeList(list);
    return merged;
  }
  const created: Connection = { id: newId(), ...clean, updatedAt: Date.now() };
  writeList([created, ...list]);
  return created;
}

export function deleteConnection(id: string): void {
  writeList(readList().filter((c) => c.id !== id));
  if (getActiveId() === id) setActiveId('');
}

/**
 * 让某个连接生效：把它的 baseUrl / apiKey / defaultAgentId 写进 weknora-settings。
 * App 其余部分只读 weknora-settings，所以切换后无需其它改动。
 */
export function applyConnection(c: Connection): void {
  const s = loadSettings();
  saveSettings({
    ...s,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    defaultAgentId: c.defaultAgentId || s.defaultAgentId,
  });
  setActiveId(c.id);
}
