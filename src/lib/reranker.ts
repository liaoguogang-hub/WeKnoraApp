/**
 * 端侧 Rerank 引擎 — 复刻 leoliao-app V36.2 的实现
 *
 * 设计目标：在 KB 检索结果上做二次精排，提升 RAG 准确率
 *
 * 三档降级（永不抛出）：
 *   Level 1: Cross-encoder（@xenova/transformers，模型 Xenova/ms-marco-MiniLM-L-6-v2）
 *   Level 2: 轻量 BM25 重打分（零依赖，中英文混合支持）
 *   Level 3: 直接返回原数组
 *
 * 性能预算：
 *   Level 1: 50 候选 × ~30ms ≈ 1.5s（3s 超时降级）
 *   Level 2: 50 候选 × <1ms ≈ <50ms
 *
 * LRU 缓存：100 条 / 30 分钟过期
 */

// === 输入输出类型（与 WeKnora 客户端保持解耦） ===
export interface RerankCandidate {
  id: string;             // chunk id
  knowledge_id?: string;
  knowledge_title?: string;
  content: string;        // chunk 文本
  score: number;          // 原始相似度分数（向后兼容）
}

export interface RerankOptions {
  topN?: number;          // 截断 top N
  timeoutMs?: number;     // L1 超时（默认 3000）
  forceFallback?: boolean;// 强制 L2
  normalize?: boolean;     // 分数归一化（默认 true）
  skipCache?: boolean;     // 跳过缓存（调试用）
}

export interface RerankStats {
  level: 'cross-encoder' | 'bm25-rescore' | 'passthrough';
  durationMs: number;
  inputCount: number;
  outputCount: number;
  timedOut: boolean;
  cacheHit?: boolean;
}

// === 权重常量集中 ===
const RERANK_WEIGHTS = {
  titleHit: 3.0,
  headingHit: 2.0,
  contentTf: 1.0,
  phraseBonus: 1.5,
  shortChunkPenalty: 0.8,
  shortChunkThreshold: 50,
} as const;

// === LRU 缓存 ===
interface CacheEntry {
  results: RerankCandidate[];
  ts: number;
  /**
   * 产生这条缓存时用的是哪一档。
   *
   * ⚠️ 必须存：命中缓存时如果硬编码成某个档位，界面会**报错档位**。
   *    原先命中就写死 level: 'bm25-rescore'，于是「神经网络精排」的结果
   *    第二次问同一个问题时会显示成「关键词精排(BM25)」—— 用户看到的是假信息。
   */
  level: RerankStats['level'];
  /** 原始耗时，命中缓存时展示它（而不是缓存查找的 0.1ms） */
  durationMs: number;
}

const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 30 * 60 * 1000;

class LRUCache {
  private map = new Map<string, CacheEntry>();
  private stats = { hits: 0, misses: 0, evictions: 0 };

  private hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  makeKey(query: string, results: RerankCandidate[], opts: RerankOptions): string {
    const resultSig = results
      .slice(0, 50)
      .map((r) => `${r.id}:${r.content.length}`)
      .join('|');
    const optsSig = JSON.stringify({
      topN: opts.topN ?? -1,
      timeoutMs: opts.timeoutMs ?? -1,
      forceFallback: !!opts.forceFallback,
      normalize: opts.normalize ?? true,
    });
    return this.hash(query + '||' + resultSig + '||' + optsSig);
  }

  get(key: string): CacheEntry | null {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this.map.delete(key);
      this.stats.misses++;
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits++;
    return entry;
  }

  set(key: string, results: RerankCandidate[], level: RerankStats['level'], durationMs: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { results, ts: Date.now(), level, durationMs });
    while (this.map.size > CACHE_MAX_SIZE) {
      const firstKey = this.map.keys().next().value;
      if (!firstKey) break;
      this.map.delete(firstKey);
      this.stats.evictions++;
    }
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.map.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total === 0 ? 0 : this.stats.hits / total,
      evictions: this.stats.evictions,
    };
  }

  clear() {
    this.map.clear();
  }
}

const _cache = new LRUCache();
export function getCacheStats() {
  return _cache.getStats();
}
export function clearRerankCache() {
  _cache.clear();
}

/**
 * 端侧模型与 ONNX Runtime wasm 的本地路径。
 *
 * 两者都随 APK 内置（源在 vite 的 public/ 下，由 scripts/fetch-model.mjs 补齐），
 * WebView 从 http://localhost/… 同源加载 —— 不涉及 CORS，且全程不需要网络。
 *
 * 为什么必须内置、而不能只配个镜像：
 *   真机实测 huggingface.co 不可达（8s 超时）；hf-mirror.com 虽然可达，但浏览器
 *   发起的 CORS 请求拿到的是缺 `Access-Control-Allow-Origin` 的响应，直接被拦掉，
 *   而 transformers.js 没有可替换 fetch 的钩子，绕不过去。
 */
export const LOCAL_MODEL_PATH = '/models/';
export const ORT_WASM_PATH = '/ort/';

// === Level 1: Cross-encoder（懒加载 @xenova/transformers） ===

/**
 * 返回 **原始 logit**（不是概率）。
 *
 * ⚠️ 必须绕开 transformers.js 的 `text-classification` pipeline：
 *    ms-marco 系列是 num_labels=1 的回归模型（config 里 id2label 只有 LABEL_0），
 *    而该 pipeline 对「单标签」不做特判，走的是
 *        problem_type === 'multi_label_classification' ? sigmoid : softmax
 *    分支 —— 对长度为 1 的向量做 softmax 恒等于 1.0。
 *    结果是所有候选分数完全相同、排序退化成空操作（看起来「跑了」其实没作用）。
 *    所以这里直接用 AutoTokenizer + AutoModelForSequenceClassification 取 logits。
 */
type CrossEncoderFn = (
  query: string,
  docs: string[],
  options?: { topk?: number }
) => Promise<Array<{ score: number; index: number }>>;

const CE_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

/** logit → 0..1 相关性（仅用于展示，且与 logit 单调，不影响排序） */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

let _crossEncoderPromise: Promise<CrossEncoderFn | null> | null = null;

/** cross-encoder 的真实状态 —— 供 UI 显示「到底有没有真的跑起来」 */
export type CrossEncoderState = 'idle' | 'loading' | 'ready' | 'failed';
let _ceState: CrossEncoderState = 'idle';
let _ceError = '';

export function getCrossEncoderState(): { state: CrossEncoderState; error: string } {
  return { state: _ceState, error: _ceError };
}

async function loadCrossEncoder(): Promise<CrossEncoderFn | null> {
  if (_crossEncoderPromise) return _crossEncoderPromise;

  _ceState = 'loading';
  _crossEncoderPromise = (async () => {
    try {
      const tf = await import('@xenova/transformers').catch(() => null);
      if (!tf) {
        console.warn('[reranker] @xenova/transformers not available');
        _ceState = 'failed';
        _ceError = 'transformers 运行时不可用';
        return null;
      }
      const { env, AutoTokenizer, AutoModelForSequenceClassification } = tf as any;
      // 模型走内置资源：localPath = localModelPath + repo_id + 文件名（无 resolve/main 段）
      env.allowLocalModels = true;
      env.localModelPath = LOCAL_MODEL_PATH;
      env.allowRemoteModels = false;
      env.useFS = false;
      // ⚠️ 坑：ort 的 wasmPaths 默认指向 jsdelivr CDN
      //    （见 @xenova/transformers src/env.js）。不改成内置目录的话，
      //    即使模型已经打进 APK，ONNX Runtime 仍会去网上拉 wasm。
      const ortWasm = (env as any)?.backends?.onnx?.wasm;
      if (ortWasm) {
        ortWasm.wasmPaths = ORT_WASM_PATH;
        ortWasm.numThreads = 1;   // WebView 没有 SharedArrayBuffer，多线程必然失败
        ortWasm.simd = true;
      }

      const tokenizer = await AutoTokenizer.from_pretrained(CE_MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(
        CE_MODEL_ID,
        { quantized: true }   // 对应内置的 onnx/model_quantized.onnx
      );
      _ceState = 'ready';
      console.log('[reranker] cross-encoder loaded (raw logits)');

      return async (query: string, docs: string[], options) => {
        // 用 text_pair 组「问题 / 文档」对，tokenizer 会正确生成 token_type_ids。
        // 旧实现把 "[SEP]" 当普通文本拼进去（`${query} [SEP] ${doc}`），
        // token_type_ids 会全是 0 —— 而 cross-encoder 正是靠它区分问题与文档。
        const inputs = tokenizer(
          docs.map(() => query),
          { text_pair: docs, padding: true, truncation: true }
        );
        const { logits } = await model(inputs);
        const data: Float32Array = logits.data;
        const dims: number[] = logits.dims;
        const rows = dims[0];
        const stride = dims.length > 1 ? dims[dims.length - 1] : 1;
        const scored: Array<{ score: number; index: number }> = [];
        for (let i = 0; i < rows; i++) {
          scored.push({ score: data[i * stride], index: i });
        }
        scored.sort((a, b) => b.score - a.score);
        return options?.topk ? scored.slice(0, options.topk) : scored;
      };
    } catch (e) {
      _ceState = 'failed';
      _ceError = (e as Error)?.message || String(e);
      console.warn('[reranker] cross-encoder load failed, will use Level 2:', e);
      return null;
    }
  })();

  return _crossEncoderPromise;
}

/**
 * 预热模型（首次约 20+MB，走 hf-mirror）。永不抛出，返回是否真的就绪。
 *
 * 为什么需要它：rerank() 内部把「下载模型」和「推理」一起压在 timeoutMs 里，
 * 第一次必然撞超时 → 退化成 BM25。预热把下载和精排解耦。
 */
export async function preloadCrossEncoder(): Promise<boolean> {
  const ce = await loadCrossEncoder();
  return !!ce;
}

// === Level 2: BM25 重打分（零依赖，中英文） ===

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '及', '等', '为', '我', '你', '他', '她', '它',
  '这', '那', '有', '没', '不', '也', '都', '就', '要', '会', '能', '把', '被', '对', '从',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'but',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'as', 'this', 'that', 'these',
  'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they',
]);

function tokenizeBM25(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const enMatches = text.toLowerCase().match(/[a-z0-9_]+/g);
  if (enMatches) {
    for (const m of enMatches) {
      if (m.length > 1 && !STOP_WORDS.has(m)) out.push(m);
    }
  }
  const cnChars = text.match(/[一-鿿]+/g);
  if (cnChars) {
    for (const seg of cnChars) {
      const chars = [...seg];
      for (const c of chars) {
        if (!STOP_WORDS.has(c)) out.push(c);
      }
      for (let i = 0; i < chars.length - 1; i++) {
        const bg = chars[i] + chars[i + 1];
        if (!STOP_WORDS.has(chars[i]) && !STOP_WORDS.has(chars[i + 1])) out.push(bg);
      }
    }
  }
  return out;
}

function bm25RescoreOne(query: string, c: RerankCandidate): number {
  const qTokens = tokenizeBM25(query);
  if (qTokens.length === 0) return 0;

  const titleLower = (c.knowledge_title || '').toLowerCase();
  const contentLower = (c.content || '').toLowerCase();

  let score = 0;
  for (const qt of qTokens) {
    if (titleLower.includes(qt)) {
      score += RERANK_WEIGHTS.titleHit;
    }
    const tf = contentLower.split(qt).length - 1;
    if (tf > 0) {
      const norm = (tf * (1.5 + 1)) / (tf + 1.5 * (1 - 0.75 + 0.75 * 1));
      score += norm * RERANK_WEIGHTS.contentTf;
    }
  }

  const qPhrase = qTokens.join('');
  if (qPhrase.length >= 4 && contentLower.includes(qPhrase)) {
    score += RERANK_WEIGHTS.phraseBonus;
  }

  if (c.content.length < RERANK_WEIGHTS.shortChunkThreshold) {
    score *= RERANK_WEIGHTS.shortChunkPenalty;
  }
  return score;
}

function normalizeScores(arr: RerankCandidate[], newScores: number[]): RerankCandidate[] {
  const max = Math.max(...newScores, 0.0001);
  return arr.map((r, i) => ({ ...r, score: newScores[i] / max }));
}

// === 主入口 ===

export async function rerank(
  query: string,
  results: RerankCandidate[],
  opts: RerankOptions = {}
): Promise<{ results: RerankCandidate[]; stats: RerankStats }> {
  const start = performance.now();
  const topN = opts.topN ?? results.length;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const normalize = opts.normalize ?? true;

  if (!results || results.length === 0 || !query.trim()) {
    return {
      results,
      stats: { level: 'passthrough', durationMs: 0, inputCount: 0, outputCount: 0, timedOut: false },
    };
  }

  // LRU 缓存
  if (!opts.skipCache) {
    const cacheKey = _cache.makeKey(query, results, opts);
    const cached = _cache.get(cacheKey);
    if (cached) {
      return {
        results: cached.results,
        stats: {
          // 用当初产生这条缓存时的真实档位 —— 不能写死，否则界面会报错档位
          level: cached.level,
          durationMs: cached.durationMs,
          inputCount: results.length,
          outputCount: cached.results.length,
          timedOut: false,
          cacheHit: true,
        },
      };
    }
  }

  // Level 1: Cross-encoder
  if (!opts.forceFallback) {
    try {
      const ce = await Promise.race([
        loadCrossEncoder(),
        new Promise<null>((_, rej) => setTimeout(() => rej(new Error('load timeout')), timeoutMs)),
      ]);
      if (ce) {
        const docs = results.map((r) => r.content);
        const scored = await Promise.race([
          ce(query, docs, { topk: topN }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('inference timeout')), timeoutMs)),
        ]);
        const out: RerankCandidate[] = [];
        for (const s of scored) {
          // CE 给的是 logit，转成 0..1 的相关性再展示
          out.push({ ...results[s.index], score: sigmoid(s.score) });
        }
        // ⚠️ 这里刻意不做 max 归一化：CE 已经是绝对的相关性概率，
        //    归一化会把最高分强行拉成 1.00，反而丢掉「到底相不相关」这个信息
        const finalResults = out;
        if (!opts.skipCache) {
          _cache.set(
            _cache.makeKey(query, results, opts),
            finalResults,
            'cross-encoder',
            Math.round(performance.now() - start)
          );
        }
        return {
          results: finalResults,
          stats: {
            level: 'cross-encoder',
            durationMs: Math.round(performance.now() - start),
            inputCount: results.length,
            outputCount: finalResults.length,
            timedOut: false,
          },
        };
      }
    } catch (e) {
      console.warn(`[reranker] Level 1 failed (${(e as Error).message}), falling back to Level 2`);
    }
  }

  // Level 2: BM25
  try {
    const scores = results.map((r) => bm25RescoreOne(query, r));
    const indexed = results.map((r, i) => ({ r, s: scores[i] }));
    indexed.sort((a, b) => b.s - a.s);
    const sliced = indexed.slice(0, topN).map((x) => x.r);
    const finalResults = normalize
      ? normalizeScores(sliced, sliced.map((_, i) => indexed[i].s))
      : sliced;
    if (!opts.skipCache) {
      _cache.set(
        _cache.makeKey(query, results, opts),
        finalResults,
        'bm25-rescore',
        Math.round(performance.now() - start)
      );
    }
    return {
      results: finalResults,
      stats: {
        level: 'bm25-rescore',
        durationMs: Math.round(performance.now() - start),
        inputCount: results.length,
        outputCount: finalResults.length,
        timedOut: false,
      },
    };
  } catch (e) {
    console.warn('[reranker] Level 2 failed, returning passthrough:', e);
    return {
      results: results.slice(0, topN),
      stats: {
        level: 'passthrough',
        durationMs: Math.round(performance.now() - start),
        inputCount: results.length,
        outputCount: Math.min(topN, results.length),
        timedOut: false,
      },
    };
  }
}

/**
 * 仅检查 cross-encoder 是否可用（UI 显示用）
 */
export async function getRerankerStatus(): Promise<{ crossEncoderAvailable: boolean }> {
  try {
    const ce = await Promise.race([
      loadCrossEncoder(),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timeout')), 500)),
    ]);
    return { crossEncoderAvailable: !!ce };
  } catch {
    return { crossEncoderAvailable: false };
  }
}