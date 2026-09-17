/**
 * 全局常量声明
 *
 * - `__APP_VERSION__`：由 `vite.config.ts` 的 `define` 在构建期注入，
 *   值为打包那一刻 `package.json` 里的 `version`。
 *   改版本号只动 `package.json` + `android/app/build.gradle` + `CHANGELOG.md` 三处即可。
 */
declare const __APP_VERSION__: string;