# WeKnoraApp — Android 客户端

WeKnora 的 Android 原生客户端，基于 **Capacitor + Lit + TypeScript**，借鉴 [leoliao-app V36.2](D:/leoliao-app) 的成熟架构。

## 📦 已实现功能

| 需求 | 状态 |
|---|---|
| ✅ Agent 联网搜索 | Web Search toggle → `web_search_enabled` |
| ✅ Agent 推理 | 默认 `builtin-smart-reasoning`（ReAct + thinking） |
| ✅ 上下文记忆 | 服务端 session + `multi_turn_enabled` |
| ✅ 多轮对话 | 同 sessionId 多次调 `/agent-chat` |
| ✅ 多会话 + 保存 | Sessions 页 + 置顶 + 删除 + 搜索 |
| ✅ 流式 SSE 渲染 | 8 种 response_type（answer / thinking / tool_call / tool_result / references / error） |
| ✅ Agent 切换 UI | Agents 页 + 选择默认 Agent |
| ✅ KB 管理 | Knowledge 页 + URL 导入 |
| ✅ 主题切换 | Light / Dark / System 三档 |
| ✅ Settings 引导 | 首次启动引导去 Settings 配置 baseUrl/apiKey |

## 🚀 一键构建 APK

```powershell
# 1. 装依赖
cd D:\WeKnoraApp
npm install

# 2. 一次性创建 Android 工程
npx cap add android

# 3. 配 Gradle 阿里云镜像（解决国内网络）
# 见下方 §Gradle 镜像配置

# 4. 编译并打 APK
npm run android:apk

# 5. 装到手机
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

## ⚙️ 必做配置

### Gradle 镜像（中国网络必备）

仿照 `D:\leoliao-app` 的 V33 修正配置：

```properties
# android\gradle\wrapper\gradle-wrapper.properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-all.zip
```

```groovy
// android\build.gradle 顶部
allprojects {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/central' }
        maven { url 'https://maven.aliyun.com/repository/public' }
        google()
        mavenCentral()
    }
}
```

### 环境变量

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\guoga\AppData\Local\Android\Sdk"
```

## 📂 工程结构

```
WeKnoraApp/
├── src/
│   ├── main.ts                       # 入口（ll-app）+ Tab 导航
│   ├── styles.css                    # 主题变量（9 var 模型）
│   ├── components/
│   │   ├── sessions-page.ts          # 会话列表（pin/搜索/删除/新建）
│   │   ├── chat-page.ts              # 流式 Chat（SSE 解析）
│   │   ├── settings-page.ts          # baseUrl/apiKey/Agent/主题
│   │   ├── agents-page.ts            # Agent 列表
│   │   └── knowledge-page.ts         # KB 列表 + URL 导入
│   └── lib/
│       └── weknora-client.ts         # API 客户端（SSE 解析器）
├── capacitor.config.ts               # appId=com.weknora.app / cleartext=true
├── vite.config.ts
├── tsconfig.json
├── package.json
└── android/                          # cap add 后生成
```

## 🎯 借鉴 leoliao-app 的关键设计

| 借鉴点 | 来源 | 本项目实现 |
|---|---|---|
| **三处 hash 一致性** | leoliao V32 §4 | Vite 内容 hash 自动保证 |
| **主题变量全套覆盖** | leoliao V29/V30 | styles.css `:root` 9 个 var |
| **状态分离（数据源/过滤/派生）** | leoliao §5 | Lit `@state` 严格分离 |
| **跨平台事件兜底** | leoliao §5.4 | 用 Lit 单一 `@input`（WebView 一致性比 RN 简单） |
| **Capacitor Share 多级降级** | leoliao §6.5 | 待用 `@capacitor/share` |
| **WebView 缓存清理** | leoliao V32 提示 | `cleartext: true` + cache-bust query |

## 🎨 图标与启动屏

统一使用 **V6B「绿色森林」** 视觉：两个错位圆角方框（白色 `#F8F7FC`）+ 绿色渐变底
（`#2D5A3D → #4D7D60 → #3A6849`，左上→右下）。

| 资源 | 文件 |
|---|---|
| 图标底色（渐变 + 顶部光晕 + 纸纹） | `res/drawable/ic_launcher_background.xml` |
| 图标图形（两方框，粗 7.2 / 细 3.2 描边） | `res/drawable/ic_launcher_foreground.xml` |
| 自适应图标入口 | `res/mipmap-anydpi-v26/ic_launcher{,_round}.xml` |
| 启动屏底色（渐变 + 径向光晕） | `res/drawable/splash_background.xml` |
| 启动屏图形（同款放大到 216dp） | `res/drawable/splash_logo.xml` |
| 启动屏合成（layer-list，居中图形） | `res/drawable/splash.xml` |
| Android 12+ 系统启动画面 | `res/values-v31/styles.xml` |

要点：

- 启动屏用 **layer-list + 居中矢量**，不用位图 —— 原先 Capacitor 默认的
  `splash.png`（480×320）会被拉伸到 1260×2720，宽高比完全破坏。
- `mipmap-anydpi-v26/*.xml` 的 `@drawable/...` 必须指向**真实存在**的资源，
  写错名字只会在 AAPT 阶段报 “resource not found”。
- 换图标后 **必须卸载重装**（`adb uninstall` + `install`），否则启动器用缓存不更新。
  重装前记得备份 localStorage（见下方 §数据备份）。

## 💾 数据备份（换图标 / 重装前必做）

App 的后端地址和 API Key 存在 WebView 的 localStorage 里，卸载会丢。华为设备路径是
`app_hws_webview`（不是 `app_webview`）：

```powershell
# 备份
adb exec-out run-as com.weknora.app tar cf - app_hws_webview shared_prefs files > backup.tar
# 卸载重装
adb uninstall com.weknora.app
adb install -r app-debug.apk
# 恢复
adb push backup.tar /data/local/tmp/
adb shell "cat /data/local/tmp/backup.tar | run-as com.weknora.app tar xf -"
```

## 🔌 调用的 WeKnora 后端 API

| 端点 | 用途 |
|---|---|
| `GET /api/v1/sessions` | 列出会话 |
| `POST /api/v1/sessions` | 新建会话 |
| `DELETE /api/v1/sessions/{id}` | 删除会话 |
| `POST /api/v1/sessions/{id}/pin` | 置顶 |
| `POST /api/v1/sessions/{id}/stop` | 停止生成 |
| `GET /api/v1/messages/{session_id}/load` | 加载历史消息 |
| `POST /api/v1/agent-chat/{session_id}` | **流式 Agent SSE** |
| `GET /api/v1/agents` | Agent 列表 |
| `GET /api/v1/knowledge-bases` | KB 列表 |
| `POST /api/v1/knowledge-bases/{id}/knowledge/url` | URL 导入 |

## 🔀 版本管理与发布

仓库：<https://github.com/liaoguogang-hub/WeKnoraApp>（public，默认分支 `main`）

### ⚠️ 推送必须走 443 端口

本机 **22 端口被拒绝**（`git@github.com:22` → Connection refused），
`ssh.github.com:443` 才通。这与 `leoliao-app` 用的是同一套规避方案：

```powershell
git remote add origin git@ssh.github.com:liaoguogang-hub/WeKnoraApp.git
```

### 日常提交

```powershell
git add -A
git commit -m "fix(chat): 描述改动"
git push
```

提交信息用 `<type>(<scope>): <描述>` 形式，`type` 取
`feat` / `fix` / `docs` / `refactor` / `chore`。

### 发版

版本号在三处保持一致（`CHANGELOG.md` 为唯一事实来源）：

| 位置 | 字段 |
|---|---|
| `package.json` | `version` |
| `android/app/build.gradle` | `versionName`（`versionCode` 每次 +1） |
| `CHANGELOG.md` | 新增版本小节 |

设置页关于区域的版本号不需要单独维护——`vite.config.ts` 在构建期把 `package.json.version`
通过 `define` 注入成 `__APP_VERSION__`（声明见 `src/env.d.ts`），源码里直接引用即可。

```powershell
# 1. 改上面三处版本号
# 2. 提交并打标签
git commit -am "v0.2.1: 一句话说明"
git tag -a v0.2.1 -m "v0.2.1: 一句话说明"
git push && git push origin v0.2.1
```

### 注意事项

- **签名文件、`google-services.json`、`local.properties` 已在 `.gitignore` 里，绝不入库。**
- 密钥只存在 App 的 localStorage（`weknora-settings`），代码里没有任何硬编码凭证。
- `android/` 下由 Capacitor 生成的内容（`capacitor-cordova-android-plugins/`、
  `app/src/main/assets/public/`、`capacitor.config.json`）由 `android/.gitignore` 排除，
  换机器后 `npm install && npx cap sync android` 即可重建。

## 📋 待办（V0.2）

- [ ] Agent @Skill / @MCP 提及
- [ ] 图片上传（Agent config 开启 `image_upload_enabled`）
- [ ] Message 全文搜索
- [ ] Session 导出 / 分享
- [ ] 离线缓存（Dexie）
- [ ] iOS build
- [ ] Play Store 发布

## 🐛 已知踩坑（参考 leoliao V32）

1. **Gradle 8.2.1 + AGP 8.2.1** 是稳定组合，避免 8.7+ 的 breaking changes
2. **`.\gradlew` 不是 `.\gradlew.bat`**（PowerShell 上 bat 会忽略 $env:JAVA_HOME）
3. **三处 hash 一致**：改任何 .ts 必须重新 `npm run sync`
4. **adb 装 APK 没生效**：`adb uninstall com.weknora.app` 后重装
5. **cleartextTraffic**: Capacitor 6 已默认开启，但 manifest 的 `network_security_config` 仍可控制特定域名
6. **SSE 出错时 `complete` 先于 `error` 到达**（实测：`agent_query → complete → error → error`，间隔约 1ms）。
   如果按「先判 complete 就收尾」处理，客户端会立刻 abort，后面的 error 永远读不到，
   用户只看到一个**空白气泡**，完全不知道是模型额度用尽。必须在 `complete` 上留
   600ms 宽限期等 `error`，并且把 `error` 判定放在 `complete` 之前。
7. **服务端出错也会落库一条 `content: ""` 的 assistant 消息**，`is_completed: true`。
   重新加载历史时若不处理，就会渲染成空白气泡 —— 需要补占位文案。
8. **华为机没有 `screenrecord`**（`inaccessible or not found`），抓启动画面只能靠
   `screencap` 连拍；配合 `settings put global animator_duration_scale 10`
   拉长窗口动画，才能稳定截到启动屏那几帧。
9. **PowerShell 里 `adb exec-out ... > file.png` 会把二进制当文本写**，
   截出来的 PNG 直接是坏的（`System.Drawing` 报 Out of memory）。必须走 `cmd /c "... > file"`。