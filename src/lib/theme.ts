/**
 * 主题系统 — 借鉴 leoliao-app V36.2
 * 6 套预设：默认深色 / 白色 / 羊皮纸 / 护眼绿 / 夜色 / 暗紫
 * 支持 localStorage 持久化 + 运行时 CSS 变量更新
 */

export interface ThemeSettings {
  presetName: string;
  bg: string;
  bg2: string;
  card: string;
  fg: string;
  fg2: string;       // 次要文字
  dim: string;       // 三级文字 / 占位符
  border: string;
  accent: string;
  accentFg: string;
  link: string;
  heading: string;
  success: string;
  warning: string;
  error: string;
  fontFamily: string;
  fontSize: number;
}

const DEFAULT_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const MONO_FONT = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

export const PRESETS: Record<string, ThemeSettings> = {
  // 1. 默认深色 — 蓝灰底、霓虹绿点缀
  '默认深色': {
    presetName: '默认深色',
    bg: '#0d1117', bg2: '#161b22', card: '#161b22',
    fg: '#e6edf3', fg2: '#adbac7', dim: '#6e7681',
    border: 'rgba(255,255,255,0.08)',
    accent: '#4d8bff', accentFg: '#ffffff',
    link: '#58a6ff', heading: '#b6cce8',
    success: '#3fb950', warning: '#d29922', error: '#f85149',
    fontFamily: DEFAULT_FONT, fontSize: 15,
  },
  // 2. 白色 — 干净明亮、蓝色高亮
  '白色': {
    presetName: '白色',
    bg: '#ffffff', bg2: '#f5f5f7', card: '#ffffff',
    fg: '#1a1a1a', fg2: '#5a6271', dim: '#9097a3',
    border: 'rgba(0,0,0,0.10)',
    accent: '#0066cc', accentFg: '#ffffff',
    link: '#0066cc', heading: '#003366',
    success: '#1ea672', warning: '#d68a00', error: '#d63a3a',
    fontFamily: DEFAULT_FONT, fontSize: 15,
  },
  // 3. 羊皮纸 — 暖色复古、护眼
  '羊皮纸': {
    presetName: '羊皮纸',
    bg: '#f4ecd8', bg2: '#e8dec2', card: '#faf3e0',
    fg: '#3a2f24', fg2: '#6b5a47', dim: '#8b7355',
    border: 'rgba(92,51,23,0.20)',
    accent: '#8b4513', accentFg: '#ffffff',
    link: '#8b4513', heading: '#5c3317',
    success: '#4a7c2c', warning: '#cc7a00', error: '#a83a2a',
    fontFamily: DEFAULT_FONT, fontSize: 16,
  },
  // 4. 护眼绿 — 浅绿底、深绿文字
  '护眼绿': {
    presetName: '护眼绿',
    bg: '#c7e0c4', bg2: '#aacba6', card: '#d4e7d2',
    fg: '#1a3a1a', fg2: '#365f33', dim: '#4f7a4d',
    border: 'rgba(13,110,13,0.25)',
    accent: '#0d6e0d', accentFg: '#ffffff',
    link: '#0d6e0d', heading: '#0a4f0a',
    success: '#0d6e0d', warning: '#b8860b', error: '#a52a2a',
    fontFamily: DEFAULT_FONT, fontSize: 15,
  },
  // 5. 夜色 — 纯黑底、蓝色点缀
  '夜色': {
    presetName: '夜色',
    bg: '#000000', bg2: '#0a0a14', card: '#0f0f1a',
    fg: '#aabbcc', fg2: '#7080a0', dim: '#4a5a6a',
    border: 'rgba(102,136,255,0.20)',
    accent: '#6688ff', accentFg: '#ffffff',
    link: '#6688ff', heading: '#88aaff',
    success: '#66ff99', warning: '#ffcc44', error: '#ff6688',
    fontFamily: DEFAULT_FONT, fontSize: 15,
  },
  // 6. 暗紫 — 深紫罗兰底、亮青点缀
  '暗紫': {
    presetName: '暗紫',
    bg: '#1a1428', bg2: '#241a3a', card: '#221836',
    fg: '#e8e0f0', fg2: '#b0a8c0', dim: '#7a7090',
    border: 'rgba(180,140,255,0.18)',
    accent: '#a87fff', accentFg: '#1a1428',
    link: '#c4a8ff', heading: '#d4bfff',
    success: '#7fd4a8', warning: '#ffc46e', error: '#ff7a8c',
    fontFamily: DEFAULT_FONT, fontSize: 15,
  },
};

const STORAGE_KEY = 'weknora-theme-settings';

export function loadTheme(): ThemeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...PRESETS['默认深色'], ...JSON.parse(raw) };
  } catch {}
  return PRESETS['默认深色'];
}

export function saveTheme(t: ThemeSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

export function applyTheme(t: ThemeSettings): void {
  const r = document.documentElement;
  r.style.setProperty('--bg', t.bg);
  r.style.setProperty('--bg-2', t.bg2);
  r.style.setProperty('--card', t.card);
  r.style.setProperty('--fg', t.fg);
  r.style.setProperty('--fg-2', t.fg2);
  r.style.setProperty('--dim', t.dim);
  r.style.setProperty('--border', t.border);
  r.style.setProperty('--accent', t.accent);
  r.style.setProperty('--accent-fg', t.accentFg);
  r.style.setProperty('--link', t.link);
  r.style.setProperty('--heading', t.heading);
  r.style.setProperty('--success', t.success);
  r.style.setProperty('--warning', t.warning);
  r.style.setProperty('--error', t.error);
  r.style.setProperty('--font', t.fontFamily);
  r.style.setProperty('--font-size', t.fontSize + 'px');
  // 简单判断深浅
  const lum = (c: string) => {
    const m = c.match(/^#?([0-9a-f]{2})/i);
    if (m) return parseInt(m[1], 16) / 255;
    return 0.5;
  };
  const dark = lum(t.bg) < 0.5;
  r.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export const MONO = MONO_FONT;