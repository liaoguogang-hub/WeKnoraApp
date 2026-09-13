# 更新日志

本文件记录 WeKnoraApp 的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] — 2026-09-13

### 新增

- **拦截 Android 返回手势**（引入 `@capacitor/app`）。此前没有任何返回键监听，
  左滑返回 / 返回键会直接把 Activity 切到桌面，看起来就是「App 被退了」。

  返回层级（刻意避免「Chat 页开抽屉、抽屉又被返回关掉」的死循环）：

  1. 非 Chat 页（设置 / 知识库 / Agent 管理）→ 回到 Chat
  2. 抽屉是用户点 ☰ 手动打开的 → 关掉抽屉
  3. Chat 页且抽屉关着 → 打开抽屉
  4. 抽屉是由返回键打开的 → 进入退出流程

  退出用「2 秒内再按一次」防误触，只弹提示不退出。

### 修复

- **左滑返回直接退出 App**。根因是缺少返回键监听；另外要注意
  `@capacitor/app` 的 `OnBackPressedCallback` 一旦加载就**始终吞掉**返回事件，
  没有注册 `backButton` 监听时只会 `webView.goBack()`（单页应用里等于没反应），
  退出必须显式调 `App.exitApp()`。

## [0.2.0] — 2026-09-12

### 新增

- **图标「V6B 绿色森林」**：两个错位圆角方框（白色 `#F8F7FC`）+ 三段绿渐变底
  （`#2D5A3D → #4D7D60 → #3A6849`）+ 顶部光晕 + 纸纹质感。
- **配套启动屏**：`layer-list`（绿渐变底 + 径向光晕 + 居中矢量图形），替换掉
  Capacitor 默认的 `splash.png`。
- `values-v31/styles.xml`：对齐 Android 12+ 系统启动画面底色与图标。
- 根 `.gitignore` 补强：签名文件（`*.jks` / `*.keystore`）、`google-services.json`、
  IDE 目录等一律不入库。

### 修复

- **SSE 终止判定顺序错误（关键）**：WeKnora 出错时的事件顺序是
  `agent_query → complete → error → error`，`complete` 比 `error` 早约 1ms。
  原实现把 `complete` 判定放在最前，收到即 `abort()`，导致后面的错误永远读不到，
  用户只看到一个**空白气泡**。
  现在 `complete` 留 600ms 宽限期等 `error`，且 `error` 判定优先于 `complete`。
- **静默失败兜底**：整条流既没有答案内容也没有 `error` 时，主动回调 `onError`，
  不再无声无息地结束。
- **错误重复渲染**：服务端同一批会重复发多条 `error`，现在每个气泡只渲染第一条。
- **错误不可读**：把技术性错误（`LLM call failed: ... status code: 429 ...`）
  翻译成用户能懂的一句话，并覆盖 401 / 403 / 404 / 5xx / 超时等情况。
- **历史空白气泡**：后端出错时会落库一条 `content: ""` 的 assistant 消息
  （`is_completed: true`），重新加载历史时现在会显示占位说明而不是空白。
- **自适应图标引用不存在的资源**：`mipmap-anydpi-v26/ic_launcher.xml` 指向了
  不存在的 `@drawable/ic_launcher_background_gradient`，导致 AAPT 编译直接失败。

## [0.1.0] — 2026-09-11

### 新增

- 项目初始化：**Capacitor 6 + Lit 3 + TypeScript + Vite 5**，Android Gradle 8.2.1 / AGP 8.2.1。
- 五项核心需求落地：Agent 联网搜索、Agent 推理、上下文记忆、多轮对话、多会话保存。
- 流式 SSE 渲染：`answer` / `thinking` / `tool_call` / `tool_result` / `references` /
  `session_title` / `complete` / `error` 八种事件。
- 会话管理页：列表、置顶、删除、搜索；进入时恢复上次会话而非新建。
- Agent 列表页 + 默认 Agent 选择。
- 知识库页：KB 浏览、文件列表、URL 导入。
- **文件下载闭环**（原生插件 `FileToolsPlugin`）：
  - 保存到公共目录 `Download/WeKnora/`（API 29+ 走 MediaStore，免权限）
  - 「打开」「分享」「文件管理」四个动作，文件管理直达 `Download/WeKnora`
  - 下载状态指示灯（绿灯=已下载 / 灰灯=未下载 / 琥珀脉冲=下载中）
- **端侧 Rerank**（借鉴 leoliao-app V36.2）：cross-encoder
  （`Xenova/ms-marco-MiniLM-L-6-v2`）→ BM25 重排 → 直通，三级降级 + LRU 缓存。
- 主题系统：6 套预设（默认深色 / 白色 / 羊皮纸 / 护眼绿 / 夜色 / 暗紫）。
- Settings 页：`baseUrl` / `apiKey` / 默认 Agent / 联网开关 + 连接自检。

### 踩坑记录

开发过程中解决的关键问题，已整理进 `README.md` 的「已知踩坑」章节：

- **Lit 必须用 Light DOM**（`createRenderRoot() { return this; }`），否则全局
  `styles.css` 全部失效，页面无样式。
- **Capacitor `androidScheme: 'http'`**：否则 HTTPS 页面请求 HTTP 后端触发
  Mixed Content 拦截。
- **不能启用 `CapacitorHttp`**：它会缓冲 `fetch` 响应，直接破坏 SSE 流式输出。
- **响应解包不能用「键数量启发式」**：`/messages/load`（2 键）和 `/agents`（3 键）
  会被误判解包，导致消息和 Agent 列表恒为空，必须显式 `unwrap()`。
- **WeKnora 的 SSE 发完终止事件后不会主动关闭连接**，不能只依赖 `reader.read()` 的 `done`。
- **华为设备 WebView 数据在 `app_hws_webview`**（不是 `app_webview`）。
- **`drawable-v24/` 里的旧 `ic_launcher_foreground.xml` 会遮蔽 `drawable/`**，
  API 24+ 上换图标不生效，必须删掉。
