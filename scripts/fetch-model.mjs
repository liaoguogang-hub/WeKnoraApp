/**
 * 把端侧 rerank 需要的大文件抓到 public/ 下（随 APK 一起打包）。
 *
 * 为什么要脚本而不是直接入库：
 *   这些二进制合计约 32MB（模型 23.9MB + ONNX Runtime wasm 10MB），
 *   直接提交会让仓库永久膨胀，且二进制不适合进 git。所以：
 *     - public/models、public/ort 在 .gitignore 里
 *     - 本脚本幂等：文件已存在且大小正确就跳过，只补缺失的部分
 *     - 已接进 `npm run build`，所以 clone 之后第一次构建会自动补齐
 *
 * 为什么必须内置（而不是运行时去镜像下载）：
 *   真机实测 huggingface.co 不可达（8s 超时）；hf-mirror.com 虽可达，但
 *   浏览器发起的 CORS 请求拿到的是缺 Access-Control-Allow-Origin 的响应，
 *   被直接拦掉，而 transformers.js 没有可替换 fetch 的钩子，绕不过去。
 *   内置后由 WebView 从 http://localhost/… 同源提供，根本不涉及 CORS。
 */
import { mkdirSync, existsSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const MIRROR = (process.env.WEKNORA_MODEL_MIRROR || 'https://hf-mirror.com').replace(/\/+$/, '');
const REPO = 'Xenova/ms-marco-MiniLM-L-6-v2';
const REV = 'main';
const BASE = `${MIRROR}/${REPO}/resolve/${REV}`;

// 期望大小 —— 用来识别下到一半/被 CDN 换成错误页的文件
const ASSETS = [
  { out: `public/models/${REPO}/config.json`, url: `${BASE}/config.json`, size: 824 },
  { out: `public/models/${REPO}/tokenizer.json`, url: `${BASE}/tokenizer.json`, size: 711396 },
  { out: `public/models/${REPO}/tokenizer_config.json`, url: `${BASE}/tokenizer_config.json`, size: 1242 },
  { out: `public/models/${REPO}/special_tokens_map.json`, url: `${BASE}/special_tokens_map.json`, size: 125 },
  { out: `public/models/${REPO}/onnx/model_quantized.onnx`, url: `${BASE}/onnx/model_quantized.onnx`, size: 23143499 },
];

// ONNX Runtime 的 wasm —— 从 node_modules 拷，保证与 @xenova/transformers 版本严格一致
const WASM = {
  out: 'public/ort/ort-wasm-simd.wasm',
  src: 'node_modules/@xenova/transformers/dist/ort-wasm-simd.wasm',
};

const ok = (p, size) => existsSync(p) && statSync(p).size === size;

async function download(url, dest, expected) {
  const t0 = Date.now();
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (expected && buf.length !== expected) {
    throw new Error(`size mismatch for ${url}: got ${buf.length}, expected ${expected}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return { bytes: buf.length, ms: Date.now() - t0 };
}

let fetched = 0;

for (const a of ASSETS) {
  const dest = resolve(ROOT, a.out);
  const name = a.out.replace(`public/models/${REPO}/`, '');
  if (ok(dest, a.size)) {
    console.log(`  ok      ${name}`);
    continue;
  }
  try {
    const r = await download(a.url, dest, a.size);
    fetched++;
    console.log(`  fetched ${name}  ${(r.bytes / 1048576).toFixed(1)}MB in ${(r.ms / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`  FAILED  ${name}: ${e.message}`);
    console.error(`\n无法获取端侧模型。请检查网络，或用 WEKNORA_MODEL_MIRROR 指定可达的镜像：`);
    console.error(`  $env:WEKNORA_MODEL_MIRROR="https://your-mirror"; npm run build`);
    process.exit(1);
  }
}

// wasm
{
  const dest = resolve(ROOT, WASM.out);
  const src = resolve(ROOT, WASM.src);
  if (!existsSync(src)) {
    console.error(`  FAILED  ort-wasm-simd.wasm: 找不到 ${WASM.src}（先跑 npm install）`);
    process.exit(1);
  }
  const size = statSync(src).size;
  if (ok(dest, size)) {
    console.log('  ok      ort-wasm-simd.wasm');
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    fetched++;
    console.log(`  copied  ort-wasm-simd.wasm  ${(size / 1048576).toFixed(1)}MB`);
  }
}

console.log(fetched === 0 ? '[model] 端侧模型资源已就绪（无需下载）' : `[model] 已补齐 ${fetched} 个文件`);
