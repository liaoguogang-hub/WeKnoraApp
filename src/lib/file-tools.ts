/**
 * 原生文件工具封装 —— 调用 Android 本地插件 FileToolsPlugin
 *
 *  - saveToDownloads   保存到「公共下载目录 /WeKnora」（系统文件管理器可见）
 *  - findDownloaded    检查是否已下载
 *  - openFile          用系统「打开方式」打开
 *  - openFileManager   调起系统自带文件管理器
 *  - deleteDownloaded  删除已下载文件
 *
 * 非原生环境（浏览器调试）返回失败，调用方走 Web 兜底。
 */

import { registerPlugin, Capacitor } from '@capacitor/core';

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
  findDownloaded(opts: { fileName: string }): Promise<FoundFile>;
  openFile(opts: { uri: string; mimeType?: string; title?: string }): Promise<{ opened: boolean }>;
  openFileManager(opts?: { fileName?: string; uri?: string }): Promise<{ opened: boolean; uri?: string }>;
  deleteDownloaded(opts: { uri?: string; fileName?: string }): Promise<{ deleted: boolean }>;
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
