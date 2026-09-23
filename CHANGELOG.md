# 更新日志

本文件记录 WeKnoraApp 的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] — 2026-09-23

### 新增

- **一个会话固定一个 Agent**。此前 Agent 是全局单值（`weknora-settings.defaultAgentId`），
  改一次会影响所有会话，也没法让 A 会话用「维基问答」、B 会话用「数据分析师」。

  实现前先探测了后端：`POST /api/v1/sessions` 带 `agent_id` 会被**丢弃**，读回来也没有
  该字段 —— 后端并不保存「会话 ↔ agent」的绑定。所以绑定只能记在客户端
  （`localStorage` 的 `weknora-session-agents`，见 `src/lib/session-agent.ts`）：

  | 场景 | 行为 |
  |---|---|
  | 新建会话 | 绑定当时的 Default Agent |
  | 会话内切换 | 只影响该会话，**不动全局默认值** |
  | 升级前的老会话 | 无记录，回落到 Default Agent（行为不变） |
  | 删除会话 | 同时清掉绑定 |

  顶部 Agent 选择器改为会话感知，并且**有会话时也会显示** —— 原先它的渲染条件是
  `!sessionId && page==='chat'`，而进入 Chat 会自动建会话，等于这个控件从不出现。
  会话列表现在也显示每个会话绑定的 agent 名。

- **端侧 Rerank 真正可用**：模型与 ONNX Runtime 的 wasm 随 APK 内置
  （源在 `public/` 下，约 32MB），由 WebView 同源加载 —— 不涉及 CORS、不需要网络、断网可用。

### 修复

- **App 连不上 NAS（cleartext 被系统拦掉）**。`network_security_config.xml` 里的
  `<base-config cleartextTrafficPermitted="false">` 会把**所有不在白名单里的 http 地址**
  拦掉，而本 App 的 `baseUrl` 是用户在设置页自填的自托管地址（公网 http 域名，或
  任意内网 IP:端口），白名单覆盖不到。表现为**立即失败（实测 8ms）**的 `Failed to fetch`。

  而且 `networkSecurityConfig` 的优先级**高于** manifest 里的
  `android:usesCleartextTraffic="true"`，后者形同虚设。

  诊断特征很好认：**`http` 全挂、`https` 正常、`http://localhost` 正常**。
  （另外 `<domain>` 不支持网段 —— 写 `192.168.0.0` 只匹配字面量主机，不代表
  `192.168.0.0/24`，所以「放行任意内网地址」用白名单表达不出来。）

  现在改为 `base-config cleartextTrafficPermitted="true"`：自托管客户端的地址无法
  预先枚举，只能整体允许 cleartext；HTTPS 不受影响（系统证书照旧）。

- **Rerank 从未执行过（关键）**。`maybeRerankInPlace` 用
  `snapshot.references.slice(prev.references.length)` 取「本回合新增的引用」，
  但 `snapshot` 是对 `prev` 的**浅拷贝**，两者 `references` 是同一个数组，
  于是 `slice(len)` 恒为 `[]`，函数每次都在第一行 `return`。
  后果是既不加载模型、也不走 BM25、界面上什么都不显示 —— 开关打开了但完全没有效果。
  现在改为对流结束后的引用全集做精排。

- **Rerank 会擦掉错误提示**。原实现挂在 `answer.done` 上，而该事件之后还有 600ms
  宽限期可能再来一条 `error`；rerank 异步完成后用旧快照整体回填，会把刚写上去的错误
  文案覆盖掉（等于把 v0.2.0 的修复又抵消回去）。现在改为在**整条流结束**后执行，
  回填时重新取当前气泡，只覆盖 `references` / `rerankStats`。

- **Rerank 档位不可见**。原先界面只显示裸的 `level` 字符串；现在翻译为
  `🎯 神经网络精排` / `🎯 关键词精排(BM25)` / `🎯 未精排`，原始值放在 `title` 里。

- **模型来源全部改为本地**。`env.remoteHost` 默认是 huggingface.co（目标网络不可达），
  `env.backends.onnx.wasm.wasmPaths` 默认是 jsdelivr CDN（不可控）。两者现在都指向
  内置资源，`allowRemoteModels` 关掉，杜绝任何外呼。

- **`open-page` 事件在顶栏区域被丢弃**。`@open-page` 原先只挂在 `<ll-sidebar>` 上，
  而 `<ll-agent-selector>` 不在 sidebar 子树里，它派发的事件冒泡到 `ll-app` 就没人接，
  导致「管理所有 Agent」点了没有任何反应、`page === 'agents'` 永远无法到达。
  现在监听器挂在 `ll-app`，可接住任何后代派发的 `open-page`；侧边栏两个按钮的派发
  补上了 `bubbles: true`（否则监听器一挪走它们就会失效）。

- **命中缓存时报错档位**。LRU 缓存命中时硬编码了 `level: 'bm25-rescore'`（原注释写作
  「缓存命中不区分级别」），于是**神经网络精排的结果，第二次问同一个问题时会在界面上
  显示成「关键词精排(BM25)」** —— 给出的是假信息。现在缓存里连档位与原始耗时一起存，
  命中时如实返回（并带 `cacheHit: true`）。

- **长回合被 25 秒空闲超时中途掐断（关键）**。WeKnora 是 ReAct 式多轮 agent，一次提问
  会跑 4~5 个 iteration，而**每个 iteration 之间的 LLM 调用期间 SSE 完全静默** ——
  真机实测到 **73~74 秒**的静默间隔。而客户端的空闲兜底超时是 25s，于是在完全正常的
  回合里中途 abort：用户看到「正在搜索」，然后答案只有开头几十个字；又因为已经收到过
  答案内容（`sawAnswer = true`），连既有的错误提示都不会显示，完全无从判断发生了什么。

  这就是「问了密码学历史，说要搜索然后没有回答」的真正原因。**服务端其实把答案完整
  落库了**：实测客户端只收到 65 字，服务端存了 6574 字。

  修法：空闲兜底超时 25s → **180s**（真正的断线由 fetch 自己抛错并立即结束，不走这条
  兜底路径，所以只需覆盖「连接还开着但服务端迟迟没有数据」）；流结束时把
  `sawAnswer` / `sawTerminal` 一并回调给上层，让调用方能判断「这次算不算完整」。

  验证：用注入的假 SSE（静默 35s）确定性复现 —— 修复前 25.9s 触发 `idle-timeout`
  并中止，修复后在 35.8s 拿到答案、`server-closed` 正常收尾。

- **流被中断时回答只显示半截，且没有任何说明**。现在流结束时若没收到终止事件
  （`complete` / `answer.done`），会：
  1. 在气泡下方提示「⚠️ 流式连接中断，回答可能不完整」；
  2. 后台轮询 `/messages/load` 把服务端已落库的完整答案取回来，成功则替换内容、
     清除提示，并弹「已从服务端取回完整回答」。

  依据：服务端是「先建 assistant 消息行、边生成边更新」，客户端中断不影响它最后落库。
  验证：把气泡截成 40 字模拟中断后，**3.3 秒**内恢复成服务端的 3515 字原文。

- **真实错误被兜底文案覆盖（关键）**。`finish()` 里那句「服务端没有返回任何内容
  （通常是模型额度不足或后端异常）」会在**已经报过真实错误之后**再报一次，把 catch
  里刚设好的错误信息盖掉 —— 用户看到的永远是这句通用文案，真凶被吞掉。

  实测踩到的例子：「关闭联网 → 提示服务端没有返回任何内容」，真实原因是
  `TypeError: Failed to fetch` —— 请求在**连接层**就失败了，**根本没到服务端**
  （服务端消息表里没有这一次的任何记录，可直接证实）。所以这个提示在误导方向。

  顺带确认：**开关本身是好的**，抓到的请求体确实带了 `"web_search_enabled": false`。

  现在：报过真实错误就不再走通用兜底；并把 fetch 层的网络错误翻译成可执行的提示
  （「连不上 WeKnora 服务端（请求没发出去）…」），不再冒充「服务端没返回内容」。

- **网络层失败（一个字都没收到）自动重试一次**。这类请求根本没到服务端，重试是
  安全且有效的：失败后 1.5 秒自动重发，成功则清掉错误提示；**只重试一次**，
  避免把偶发失败放大成循环。

  验证（注入 mock fetch，零额度）：让第一次抛 `Failed to fetch`、第二次返回正常 SSE
  → 自动重试后拿到答案且无错误；持续失败 → 恰好 2 次尝试 + 显示真实原因。

- **（本次自查发现）「从服务端取回答案」会跨轮拿错**。`reconcileFromServer` 原先取
  「会话里最新一条 assistant 消息」；若这一轮的请求压根没到服务端，那条其实是
  **上一轮**的答案，会被填进新气泡。现在按 `assistant_message_id` 绑定，退一步用
  `created_at` 限定在本轮之后；本轮在服务端没有任何记录时直接放弃，不乱动气泡。

  验证：未绑定 → 16 秒后停在截断状态，未被旧答案污染；正确绑定 → 3.2 秒恢复成
  服务端原文。

- **实时内容与「重开会话后」的内容不一致**。流式过程中，工具调用之间的**过程口述**
  （「我来检索一下…让我再深入阅读某某章节…」）是当 `answer` 事件发出来的，客户端
  会把它一起渲染进答案；而服务端只保存**最后一个 iteration 的输出**（前面的口述落在
  `agent_steps.thought` 里）。真机实测：同一轮回答，实时显示 6715 字，重开会话后
  变成 6520 字 —— 开头那 195 字口述凭空消失。

  现在收到 `tool_call` 时，把当前累积的正文从 `content` 移到 `thinking` 区：既保留
  （用户仍看得到 agent 的进度），又不再混进答案。

  验证：用真机上那段真实的 195 字口述 + 服务端真实的 6520 字答案重放该结构 →
  回合结束后气泡正文与服务端**逐字一致**（`byteIdenticalToServer: true`），
  口述落在 `thinking` 里。

- 补一条兜底：回合**干净结束**但气泡里没留下正文时（例如最后一个 iteration 只发了
  工具调用），也会去服务端取一次内容。

### 工具

- **`npm run verify:rerank`**：真机自检，一条命令给出 PASS / FAIL。
  往聊天页注入一组判别性候选（其中「语义相关但字面无重合」的一条**故意放在第 2 位**），
  直接调用精排逻辑，断言 6 项：档位是 `cross-encoder`、分数互不相同、语义那条升到第 1、
  无关条目排最后、本次是全新推理而非缓存命中、未覆盖消息正文。
  不需要提问、不消耗模型额度；候选 id 带随机后缀以绕过缓存，强制真实推理。
  这个脚本上线当天就抓出了上面那条「命中缓存报错档位」的 bug。

### 说明

- 端侧模型约 32MB，**不进 git**（`.gitignore` 排除 `public/models/`、`public/ort/`）。
  由 `npm run fetch-model` 补齐，并已接入 `npm run build`，clone 后首次构建会自动下载；
  脚本幂等，文件齐全时不会重复下载。可用 `WEKNORA_MODEL_MIRROR` 指定镜像。

## [0.2.2] — 2026-09-13

### 修复

- **设置页关于区域显示旧版本号 0.2.0**（v0.2.1 的 APK 里也错）。根因是
  `settings-page.ts` 里硬编码了字符串 `"WeKnora Android Client v0.2.0"`，
  跟 `package.json` 是两份独立维护的版本号，升版本时漏改。

  现在通过 Vite 的 `define` 在构建期把 `package.json.version` 替换成 `__APP_VERSION__`
  注入到 bundle（声明见 `src/env.d.ts`），后续升版本只改一处。

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
