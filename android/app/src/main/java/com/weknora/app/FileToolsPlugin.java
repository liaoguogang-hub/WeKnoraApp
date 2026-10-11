package com.weknora.app;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * WeKnora 本地原生插件 —— 补齐 WebView 做不到的能力：
 *
 *  1) saveToDownloads  把文件保存到「公共下载目录 /WeKnora」，系统文件管理器可见
 *  2) openFile         用系统「打开方式」打开文件（ACTION_VIEW，不是分享面板）
 *  3) openFileManager  调起系统自带的文件管理器
 *  4) deleteDownloaded 删除已保存到公共目录的文件
 */
@CapacitorPlugin(name = "FileTools")
public class FileToolsPlugin extends Plugin {

    private static final String SUB_DIR = "WeKnora";

    // ============ 工具 ============

    /** file:// → FileProvider content:// （Android 7+ 必需） */
    private Uri toContentUri(Uri uri) {
        if (uri == null) return null;
        if ("content".equals(uri.getScheme())) return uri;
        if ("file".equals(uri.getScheme())) {
            try {
                File f = new File(uri.getPath());
                String authority = getContext().getPackageName() + ".fileprovider";
                return FileProvider.getUriForFile(getContext(), authority, f);
            } catch (Exception e) {
                return uri;
            }
        }
        return uri;
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".doc")) return "application/msword";
        if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (n.endsWith(".xls")) return "application/vnd.ms-excel";
        if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (n.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
        if (n.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".epub")) return "application/epub+zip";
        return "*/*";
    }

    // ============ 1) 保存到公共下载目录 ============

    /**
     * 参数： fileName（文件名）、data（base64，不含 data: 前缀）、mimeType（可选）
     * 返回： uri（content:// 或 file://）、path（可读路径）
     */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String fileName = call.getString("fileName");
        String data = call.getString("data");
        if (fileName == null || fileName.isEmpty() || data == null) {
            call.reject("fileName 和 data 必填");
            return;
        }
        String mime = call.getString("mimeType");
        if (mime == null || mime.isEmpty()) mime = guessMime(fileName);

        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            Uri savedUri;
            String savedPath;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+：走 MediaStore，无需存储权限
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                // 同名的先删掉，避免 _1 _2 递增
                try {
                    resolver.delete(collection,
                            MediaStore.Downloads.DISPLAY_NAME + "=? AND " +
                                    MediaStore.Downloads.RELATIVE_PATH + "=?",
                            new String[]{ fileName, Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR });
                } catch (Exception ignored) {}

                savedUri = resolver.insert(collection, values);
                if (savedUri == null) {
                    call.reject("无法创建下载文件");
                    return;
                }
                OutputStream os = resolver.openOutputStream(savedUri);
                if (os == null) {
                    call.reject("无法写入下载文件");
                    return;
                }
                os.write(bytes);
                os.flush();
                os.close();

                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(savedUri, values, null, null);
                savedPath = Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR + "/" + fileName;
            } else {
                // Android 9 及以下：直接写公共目录
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        SUB_DIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建下载目录");
                    return;
                }
                File out = new File(dir, fileName);
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(bytes);
                fos.flush();
                fos.close();
                savedUri = Uri.fromFile(out);
                savedPath = out.getAbsolutePath();
            }

            JSObject ret = new JSObject();
            ret.put("uri", savedUri.toString());
            ret.put("path", savedPath);
            ret.put("fileName", fileName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("保存失败: " + e.getMessage());
        }
    }

    // ============ 1b) 原生流式下载到公共下载目录 ============

    /**
     * 参数：url、apiKey（作为 X-API-Key 头）、fileName、mimeType（可选）
     * 返回：uri / path / fileName / size
     *
     * 为什么需要它：把整个文件转 base64 再经 Capacitor 桥交给原生，数据会放大
     * 约 1.33 倍，而且同一份内容同时存在于 JS 堆、桥接字符串和 native 堆里。
     * NAS 知识库里有 30MB+ 的 PDF/epub，那条路会 OOM 或长时间卡死。
     * 这里改成原生流式落盘：内存占用固定为 64KB 缓冲区，并且能回报进度。
     *
     * 插件方法默认在主线程执行，直接做网络 I/O 会抛 NetworkOnMainThreadException，
     * 所以整段丢给 Bridge 的后台线程池。
     */
    @PluginMethod
    public void downloadToDownloads(final PluginCall call) {
        final String url = call.getString("url");
        final String fileName = call.getString("fileName");
        final String apiKey = call.getString("apiKey");
        if (url == null || url.isEmpty() || fileName == null || fileName.isEmpty()) {
            call.reject("url 和 fileName 必填");
            return;
        }
        String mimeIn = call.getString("mimeType");
        final String mime = (mimeIn == null || mimeIn.isEmpty()) ? guessMime(fileName) : mimeIn;

        getBridge().execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                InputStream in = null;
                OutputStream os = null;
                Uri savedUri = null;
                File legacyFile = null;
                boolean created = false;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(120000);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("Accept", "*/*");
                    if (apiKey != null && !apiKey.isEmpty()) {
                        conn.setRequestProperty("X-API-Key", apiKey);
                    }

                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) {
                        String detail = readErrorStream(conn);
                        call.reject("服务端返回 HTTP " + code + (detail.isEmpty() ? "" : "：" + detail));
                        return;
                    }
                    final long total = conn.getContentLengthLong();
                    in = conn.getInputStream();

                    ContentResolver resolver = getContext().getContentResolver();
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                        values.put(MediaStore.Downloads.MIME_TYPE, mime);
                        values.put(MediaStore.Downloads.RELATIVE_PATH,
                                Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR);
                        values.put(MediaStore.Downloads.IS_PENDING, 1);
                        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                        try {
                            resolver.delete(collection,
                                    MediaStore.Downloads.DISPLAY_NAME + "=? AND " +
                                            MediaStore.Downloads.RELATIVE_PATH + "=?",
                                    new String[]{ fileName, Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR });
                        } catch (Exception ignored) {}
                        savedUri = resolver.insert(collection, values);
                        if (savedUri == null) {
                            call.reject("无法在下载目录创建文件");
                            return;
                        }
                        created = true;
                        os = resolver.openOutputStream(savedUri);
                        if (os == null) {
                            call.reject("无法写入下载文件");
                            return;
                        }
                    } else {
                        File dir = new File(
                                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                                SUB_DIR);
                        if (!dir.exists() && !dir.mkdirs()) {
                            call.reject("无法创建下载目录（Android 9 及以下需要存储权限）");
                            return;
                        }
                        legacyFile = new File(dir, fileName);
                        os = new FileOutputStream(legacyFile);
                        savedUri = Uri.fromFile(legacyFile);
                        created = true;
                    }

                    byte[] buf = new byte[64 * 1024];
                    long received = 0;
                    long lastEmit = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 250) {
                            lastEmit = now;
                            JSObject p = new JSObject();
                            p.put("fileName", fileName);
                            p.put("received", received);
                            p.put("total", total);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                    os.flush();
                    os.close();
                    os = null;
                    in.close();
                    in = null;

                    if (received == 0) {
                        throw new IllegalStateException("下载内容为空（0 字节）");
                    }

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues done = new ContentValues();
                        done.put(MediaStore.Downloads.IS_PENDING, 0);
                        resolver.update(savedUri, done, null, null);
                    }

                    JSObject ret = new JSObject();
                    ret.put("uri", savedUri.toString());
                    ret.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR + "/" + fileName);
                    ret.put("fileName", fileName);
                    ret.put("size", received);
                    ret.put("total", total);
                    call.resolve(ret);
                } catch (Exception e) {
                    // 失败时清掉已插入的半成品，避免下载目录里留下 0 字节残file
                    if (created) {
                        try {
                            if (legacyFile != null) {
                                if (legacyFile.exists()) legacyFile.delete();
                            } else if (savedUri != null) {
                                getContext().getContentResolver().delete(savedUri, null, null);
                            }
                        } catch (Exception ignored) {}
                    }
                    String msg = e.getMessage();
                    call.reject("下载失败: " + (msg == null ? e.getClass().getSimpleName() : msg));
                } finally {
                    try { if (os != null) os.close(); } catch (Exception ignored) {}
                    try { if (in != null) in.close(); } catch (Exception ignored) {}
                    if (conn != null) conn.disconnect();
                }
            }
        });
    }

    /** 读取错误响应体（最多 512 字节），把服务端的真实原因带给用户 */
    private String readErrorStream(HttpURLConnection conn) {
        InputStream es = null;
        try {
            es = conn.getErrorStream();
            if (es == null) return "";
            byte[] buf = new byte[512];
            int n = es.read(buf);
            if (n <= 0) return "";
            return new String(buf, 0, n, java.nio.charset.StandardCharsets.UTF_8)
                    .replaceAll("\\s+", " ").trim();
        } catch (Exception e) {
            return "";
        } finally {
            try { if (es != null) es.close(); } catch (Exception ignored) {}
        }
    }

    /** 检查公共下载目录里是否已有该文件，有则直接返回其位置 */
    @PluginMethod
    public void findDownloaded(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null || fileName.isEmpty()) {
            call.reject("fileName 必填");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                String[] projection = {
                        MediaStore.Downloads._ID,
                        MediaStore.Downloads.SIZE
                };
                String selection = MediaStore.Downloads.DISPLAY_NAME + "=? AND " +
                        MediaStore.Downloads.RELATIVE_PATH + "=?";
                String[] args = { fileName, Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR };
                android.database.Cursor c = resolver.query(collection, projection, selection, args, null);
                if (c != null) {
                    try {
                        if (c.moveToFirst()) {
                            long id = c.getLong(0);
                            long size = c.getLong(1);
                            Uri uri = Uri.withAppendedPath(collection, String.valueOf(id));
                            JSObject ret = new JSObject();
                            ret.put("exists", true);
                            ret.put("uri", uri.toString());
                            ret.put("size", size);
                            ret.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR + "/" + fileName);
                            call.resolve(ret);
                            return;
                        }
                    } finally {
                        c.close();
                    }
                }
            } else {
                File out = new File(
                        new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), SUB_DIR),
                        fileName);
                if (out.exists()) {
                    JSObject ret = new JSObject();
                    ret.put("exists", true);
                    ret.put("uri", Uri.fromFile(out).toString());
                    ret.put("size", out.length());
                    ret.put("path", out.getAbsolutePath());
                    call.resolve(ret);
                    return;
                }
            }
            JSObject ret = new JSObject();
            ret.put("exists", false);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("exists", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    // ============ 2) 打开文件 ============

    @PluginMethod
    public void openFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("uri is required");
            return;
        }
        String mime = call.getString("mimeType");
        if (mime == null || mime.isEmpty()) mime = "*/*";
        try {
            Uri uri = toContentUri(Uri.parse(uriStr));
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mime);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            String title = call.getString("title", "选择打开方式");
            Intent chooser = Intent.createChooser(intent, title);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (ActivityNotFoundException e) {
            call.reject("没有可打开该类型文件的应用");
        } catch (Exception e) {
            call.reject("打开失败: " + e.getMessage());
        }
    }

    // ============ 3) 系统文件管理器（直达文件所在文件夹）============

    /** 我们的下载目录在主存储里的 document id：primary:Download/WeKnora */
    private Uri downloadsFolderUri() {
        String docId = "primary:" + Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR;
        try {
            return DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", docId);
        } catch (Exception e) {
            return Uri.parse("content://com.android.externalstorage.documents/document/primary%3A"
                    + Environment.DIRECTORY_DOWNLOADS + "%2F" + SUB_DIR);
        }
    }

    /**
     * 构建「打开该目录」的意图。
     *
     * 关键点：目录 MIME 有多方声明（DocumentsUI、ES文件浏览器、部分地图 App 等），
     * 不指定包名会弹 chooser，可能被别的 App 接管并落到根目录。
     * 实测指定 com.android.documentsui 后可直接定位到目标文件夹。
     */
    private java.util.List<Intent> buildFolderIntents(Uri folderUri) {
        final String DIR_MIME = DocumentsContract.Document.MIME_TYPE_DIR; // vnd.android.document/directory
        java.util.List<Intent> list = new java.util.ArrayList<>();

        // 1) 首选：显式指定 AOSP DocumentsUI（Files）
        for (String pkg : new String[] { "com.android.documentsui", "com.google.android.documentsui" }) {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(folderUri, DIR_MIME);
            i.putExtra("android.provider.extra.INITIAL_URI", folderUri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.setPackage(pkg);
            list.add(i);
        }

        // 2) 不指定包名（交给系统挑选，部分 ROM 只有默认文件管理器）
        Intent i2 = new Intent(Intent.ACTION_VIEW);
        i2.setDataAndType(folderUri, DIR_MIME);
        i2.putExtra("android.provider.extra.INITIAL_URI", folderUri);
        i2.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        list.add(i2);

        // 3) 旧式 resource/folder
        Intent i3 = new Intent(Intent.ACTION_VIEW);
        i3.setDataAndType(folderUri, "resource/folder");
        i3.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        list.add(i3);

        // 4) 系统选择器：EXTRA_INITIAL_URI 会停在该文件夹
        Intent i4 = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i4.addCategory(Intent.CATEGORY_OPENABLE);
        i4.setType("*/*");
        i4.putExtra("android.provider.extra.INITIAL_URI", folderUri);
        list.add(i4);

        return list;
    }

    /**
     * 调起系统文件管理器并**直接定位到文件所在文件夹**（Download/WeKnora）。
     * 参数： fileName（可选）、uri（可选）
     */
    @PluginMethod
    public void openFileManager(PluginCall call) {
        Uri folderUri = downloadsFolderUri();
        java.util.List<Intent> tries = buildFolderIntents(folderUri);

        for (Intent it : tries) {
            if (it == null) continue;
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(it);
                JSObject ret = new JSObject();
                ret.put("opened", true);
                ret.put("uri", folderUri.toString());
                ret.put("target", it.getPackage() != null ? it.getPackage() : "(system chooser)");
                call.resolve(ret);
                return;
            } catch (Exception ignored) {
                // 继续尝试下一种
            }
        }
        call.reject("未找到可用的系统文件管理器");
    }

    // ============ 4) 删除已下载 ============

    @PluginMethod
    public void deleteDownloaded(PluginCall call) {
        String uriStr = call.getString("uri");
        String fileName = call.getString("fileName");
        try {
            if (uriStr != null && !uriStr.isEmpty()) {
                getContext().getContentResolver().delete(Uri.parse(uriStr), null, null);
            } else if (fileName != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                getContext().getContentResolver().delete(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        MediaStore.Downloads.DISPLAY_NAME + "=? AND " +
                                MediaStore.Downloads.RELATIVE_PATH + "=?",
                        new String[]{ fileName, Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR });
            }
            JSObject ret = new JSObject();
            ret.put("deleted", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("删除失败: " + e.getMessage());
        }
    }
}
