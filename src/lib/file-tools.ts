/**
 * 原生文件工具封装 —— 调用 Android 本地插件 FileToolsPlugin
 *
 *  - downloadToDownloads 原生流式下载到「公共下载目录 /WeKnora」（推荐，大文件也能下）
 *  - saveToDownloads   把内存里的 base64 存到公共下载目录（小文件/兜底用）
 *  - findDownloaded    检查是否已下载
 *  - openFile          用系统「打开方式」打开
 *  - openFileManager   调起系统自带文件管理器
 *  - deleteDownloaded  删除已下载文件
 *
 * 非原生环境（浏览器调试）返回失败，调用方走 Web 兜底。
 */

import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';


interface SavedFile {
  uri: string;
  path: string;
  fileName: string;
}

interface FoundFile {
  exists: boolean;
  uri?: string;
  size?: number;
  path?: string;
}

interface FileToolsPlugin {
  saveToDownloads(opts: { fileName: string; data: string; mimeType?: string }): Promise<SavedFile>;
  downloadToDownloads(opts: {
    url: string;
    fileName: string;
    apiKey?: string;
    mimeType?: string;
  }): Promise<DownloadedFile & { total?: number }>;
  findDownloaded(opts: { fileName: string }): Promise<FoundFile>;
  openFile(opts: { uri: string; mimeType?: string; title?: string }): Promise<{ opened: boolean }>;
  openFileManager(opts?: { fileName?: string; uri?: string }): Promise<{ opened: boolean; uri?: string }>;
  deleteDownloaded(opts: { uri?: string; fileName?: string }): Promise<{ deleted: boolean }>;
  addListener(
    eventName: 'downloadProgress',
    cb: (data: { fileName: string; received: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export interface DownloadedFile {
  uri: string;
  path: string;
  fileName: string;
  size: number;
}

const FileTools = registerPlugin<FileToolsPlugin>('FileTools');

/** 扩展名 → MIME */
export function mimeOf(fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    zip: 'application/zip',
    epub: 'application/epub+zip',
  };
  return map[ext] || '*/*';
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** 保存到公共下载目录，返回保存位置 */
export async function saveToDownloads(
  fileName: string,
  base64: string,
): Promise<SavedFile | null> {
  if (!isNative()) return null;
  try {
    return await FileTools.saveToDownloads({ fileName, data: base64, mimeType: mimeOf(fileName) });
  } catch (e) {
    console.warn('[filetools] saveToDownloads failed:', e);
    return null;
  }
}

/**
 * 原生流式下载：文件在 Java 侧边收边落盘，完全不经过 JS，也不经过 base64。
 *
 * 与 saveToDownloads 的关键区别：这个会把失败原因**原样抛出**
 * （例如「服务端返回 HTTP 500：{...resource not found...}」），
 * 而不是吞掉返回 null —— 界面才能显示真实原因。
 *
 * 内存占用固定 64KB 缓冲，30MB+ 的文件也不会 OOM。
 * 非原生环境抛 NOT_NATIVE，调用方据此回退到 fetch + base64 的老路。
 */
export async function downloadToDownloads(
  url: string,
  fileName: string,
  apiKey?: string,
): Promise<DownloadedFile> {
  if (!isNative()) throw new Error('NOT_NATIVE');
  return await FileTools.downloadToDownloads({
    url,
    fileName,
    apiKey: apiKey || '',
    mimeType: mimeOf(fileName),
  });
}

/** 订阅原生下载进度，返回取消订阅的函数；非原生环境返回空操作 */
export async function onDownloadProgress(
  cb: (p: { fileName: string; received: number; total: number }) => void,
): Promise<() => void> {
  if (!isNative()) return () => {};
  try {
    const handle = await FileTools.addListener('downloadProgress', cb);
    return () => { void handle.remove(); };
  } catch {
    return () => {};
  }
}

/** 查询是否已下载（返回在公共目录里的位置） */
export async function findDownloaded(fileName: string): Promise<FoundFile> {
  if (!isNative()) return { exists: false };
  try {
    return await FileTools.findDownloaded({ fileName });
  } catch {
    return { exists: false };
  }
}

/** 用系统「打开方式」打开文件 */
export async function openFileNative(uri: string, fileName: string, title?: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await FileTools.openFile({ uri, mimeType: mimeOf(fileName), title });
    return true;
  } catch (e) {
    console.warn('[filetools] openFile failed:', e);
    return false;
  }
}

/** 调起系统文件管理器，直接定位到文件所在文件夹（Download/WeKnora） */
export async function openFileManager(fileName?: string, uri?: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const opts: { fileName?: string; uri?: string } = {};
    if (fileName) opts.fileName = fileName;
    if (uri) opts.uri = uri;
    await FileTools.openFileManager(opts);
    return true;
  } catch (e) {
    console.warn('[filetools] openFileManager failed:', e);
    return false;
  }
}

/** 删除已下载文件 */
export async function deleteDownloaded(uri?: string, fileName?: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await FileTools.deleteDownloaded({ uri, fileName });
    return true;
  } catch {
    return false;
  }
}
