export const FALLBACK_MODEL_IDS = [
  "deepseek-v4.1-flash-free",
  "big-pickle",
  "beam-free",
  "mimo-v2.6-flash-free",
  "glm-5.3-flash-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "longcat-2.5-preview-free",
  "jev-1.13-free",
  "minimax-m3.1-flash-free",
];

export const DEFAULT_EXTRA_FREE = ["big-pickle"];

export function isFreeModel(id, extraFree = DEFAULT_EXTRA_FREE) {
  if (!id || id === "test") return false;
  return id.endsWith("-free") || extraFree.includes(id);
}

const NAME_FIXES = {
  glm: "GLM",
  vl: "VL",
  mimo: "MiMo",
  deepseek: "DeepSeek",
  longcat: "LongCat",
  ai: "AI",
};

export function prettyName(id) {
  const base = id.replace(/-free$/, "");
  const words = base.split("-").map((word) => {
    const fixed = NAME_FIXES[word.toLowerCase()];
    if (fixed) return fixed;
    return word[0].toUpperCase() + word.slice(1);
  });
  return words.join(" ") + (id.endsWith("-free") ? " Free" : "");
}

/**
 * dsh 的推理等级阶梯，顺序即 UI 展示顺序（`off` 在最前）。
 * 与 dsh-llm-pi-ai 的 THINKING_LEVELS 保持一致。
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 除 `off` 之外的等级，供 CATALOG 里的 `efforts` 复用。 */
const FULL_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 每个模型真实提供的推理等级（`off` 之外的部分）。
 *
 * 取值依据是 OpenCode 自家 models.dev 目录里该模型的 `reasoning_options`，
 * 并与本桥实测上游是否接受对应 `reasoning_effort` 交叉核对过：
 * - `reasoning_options: [{ type: "effort", values: [...] }]` → 只声明列出的等级；
 * - `reasoning_options: [{ type: "toggle" }]` / `[]` → 上游接受整条阶梯，
 *   但目录未细分，按整条阶梯声明（`off` 由 {@link reasoningEfforts} 自动补上）。
 *
 * `off` 一律以「无值」形式声明：pi-ai 把它翻译成「不发送 reasoning_effort」，
 * 而不是发送 `"none"`——`space-bunny-free` 等模型会拒绝 `"none"`。
 */
export const CATALOG = {
  // 上游拒绝 minimal / xhigh（400），其余 5 级可用。
  "big-pickle": {
    name: "Big Pickle",
    image: false,
    contextWindow: 200000,
    maxTokens: 32000,
    efforts: ["low", "medium", "high", "max"],
  },
  // 该模型被地区限制（403），推理等级照目录声明，不影响报错本身。
  "beam-free": { name: "Beam Free", image: false, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "mimo-v2.6-flash-free": {
    name: "MiMo V2.6 Flash Free",
    image: true,
    contextWindow: 200000,
    maxTokens: 32000,
    efforts: FULL_LADDER,
  },
  "minimax-m3.1-flash-free": {
    name: "MiniMax M3.1 Flash Free",
    image: true,
    contextWindow: 1000000,
    maxTokens: 512000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  "nemotron-3.5-super-vl-free": {
    name: "Nemotron 3.5 Super VL Free",
    image: true,
    contextWindow: 1048576,
    maxTokens: 131072,
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  "nemotron-3.5-lightning-free": {
    name: "Nemotron 3.5 Lightning Free",
    image: false,
    contextWindow: 262144,
    maxTokens: 262144,
    efforts: FULL_LADDER,
  },
  // 上游协议不兼容（400 ModelProtocolUnsupported），不声明推理等级。
  "jev-1.13-free": { name: "Jev 1.13 Free", image: false, efforts: false },
  "longcat-2.5-preview-free": {
    name: "LongCat 2.5 Preview Free",
    image: true,
    contextWindow: 1000000,
    maxTokens: 131072,
    efforts: FULL_LADDER,
  },
  // 目录只给 low / high / max —— 含 MAX。
  "deepseek-v4.1-flash-free": {
    name: "DeepSeek V4.1 Flash Free",
    image: true,
    contextWindow: 200000,
    maxTokens: 32000,
    efforts: ["low", "high", "max"],
  },
  "glm-5.3-flash-free": {
    name: "GLM 5.3 Flash Free",
    image: true,
    contextWindow: 200000,
    maxTokens: 32000,
    efforts: ["low", "high", "max"],
  },
  "space-bunny-free": {
    name: "Space Bunny Free",
    image: true,
    contextWindow: 1048576,
    maxTokens: 524288,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
};

/**
 * OpenCode Go（订阅制）模型目录。
 *
 * 与 {@link CATALOG} 同构，但数据来自 models.dev 的 `opencode-go` provider
 * （与 OpenCode 官方 Go 文档里的模型清单一致）：名称、是否支持图片、
 * 上下文 / 输出上限都按目录里的 `limit` 填；推理等级由 `reasoning_options`
 * 推导——`effort.values` 只取列出的等级，`toggle` / `budget_tokens` / 缺省
 * 视为整条阶梯，`none` 由 dsh 的 `off`（不发送参数）表达。
 *
 * 上游目录调整后无需改代码：`lib/catalog.mjs` 会在启动时用 models.dev
 * 的新数据覆盖这里的静态值，这里只作为离线回退。
 */
export const GO_CATALOG = {
  "beam-free": { name: "Beam Free", image: false, contextWindow: 1048576, maxTokens: 131072, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "cat-jam-free": { name: "Cat Jam Free", image: false, contextWindow: 1048576, maxTokens: 131072, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "claude-haiku-5-5": { name: "Claude Haiku 5.5", image: true, contextWindow: 1000000, maxTokens: 128000, efforts: FULL_LADDER },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", image: false, contextWindow: 1000000, maxTokens: 384000, efforts: ["high", "max"] },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", image: true, contextWindow: 1000000, maxTokens: 384000, efforts: ["low", "high", "max"] },
  "gemini-4-argon-contributor": { name: "Gemini 4 Argon Contributor", image: true, contextWindow: 1048576, maxTokens: 65536, efforts: ["low", "medium", "high"] },
  "glm-5.2": { name: "GLM-5.2", image: false, contextWindow: 1000000, maxTokens: 131072, efforts: ["high", "max"] },
  "glm-5.3": { name: "GLM-5.3", image: false, contextWindow: 1000000, maxTokens: 131072, efforts: ["low", "high", "max"] },
  "glm-5.3-flash": { name: "GLM-5.3 Flash", image: true, contextWindow: 1000000, maxTokens: 131072, efforts: ["low", "high", "max"] },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", image: true, contextWindow: 1050000, maxTokens: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-luna": { name: "GPT-6 Luna", image: true, contextWindow: 1050000, maxTokens: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "grok-4.7": { name: "Grok 4.7", image: true, contextWindow: 500000, maxTokens: 500000, efforts: ["low", "medium", "high", "xhigh"] },
  "hy3": { name: "Hy3", image: false, contextWindow: 256000, maxTokens: 128000, efforts: ["low", "high"] },
  "hy4-preview": { name: "Hy4 preview", image: false, contextWindow: 1024000, maxTokens: 64000, efforts: ["high"] },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", image: true, contextWindow: 262144, maxTokens: 262144, efforts: FULL_LADDER },
  "kimi-k3": { name: "Kimi K3", image: true, contextWindow: 1048576, maxTokens: 131072, efforts: ["max"] },
  "longcat-2.0": { name: "LongCat-2.0", image: false, contextWindow: 1000000, maxTokens: 131072, efforts: FULL_LADDER },
  "longcat-2.5-preview-free": { name: "LongCat 2.5 Preview Free", image: true, contextWindow: 1000000, maxTokens: 131072, efforts: FULL_LADDER },
  "mimo-v2.5": { name: "MiMo V2.5", image: true, contextWindow: 1000000, maxTokens: 128000, efforts: FULL_LADDER },
  "mimo-v2.5-pro": { name: "MiMo V2.5 Pro", image: true, contextWindow: 1048576, maxTokens: 128000, efforts: FULL_LADDER },
  "mimo-v2.6-flash": { name: "MiMo V2.6 Flash", image: true, contextWindow: 1048576, maxTokens: 131072, efforts: FULL_LADDER },
  "mimo-v2.6-pro": { name: "MiMo V2.6 Pro", image: true, contextWindow: 1048576, maxTokens: 131072, efforts: FULL_LADDER },
  "minimax-m2.7": { name: "MiniMax M2.7", image: false, contextWindow: 204800, maxTokens: 131072, efforts: FULL_LADDER },
  "minimax-m3": { name: "MiniMax M3", image: false, contextWindow: 1000000, maxTokens: 131072, efforts: FULL_LADDER },
  "minimax-m3.1-flash-free": { name: "MiniMax M3.1 Flash Free", image: true, contextWindow: 1000000, maxTokens: 512000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "muse-spark-1.2-contributor": { name: "Muse Spark 1.2 Contributor", image: true, contextWindow: 1048576, maxTokens: 131072, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  "muse-spark-1.3-contributor": { name: "Muse Spark 1.3 Contributor", image: true, contextWindow: 1048576, maxTokens: 131072, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  "qwen3.7-plus": { name: "Qwen3.7 Plus", image: true, contextWindow: 1000000, maxTokens: 65536, efforts: FULL_LADDER },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", image: true, contextWindow: 1000000, maxTokens: 131072, efforts: FULL_LADDER },
  "qwen3.8-max": { name: "Qwen3.8 Max", image: true, contextWindow: 1000000, maxTokens: 131072, efforts: FULL_LADDER },
  "space-bunny": { name: "Space Bunny", image: true, contextWindow: 1048576, maxTokens: 524288, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "step-5-preview": { name: "Step 5 Preview", image: true, contextWindow: 1000000, maxTokens: 65536, efforts: ["low", "medium", "high"] },
  "step-5-preview-free": { name: "Step 5 Preview Free", image: true, contextWindow: 1000000, maxTokens: 65536, efforts: ["low", "medium", "high"] },
};

/** Go 目录拉取失败时的回退 id 列表（与 {@link GO_CATALOG} 的键一致，保持目录顺序）。 */
export const FALLBACK_GO_MODEL_IDS = Object.keys(GO_CATALOG);

/** Go 目录里同样以 `-free` 结尾的模型（Go 订阅下的限时免费额度，不是 Zen 免费层）。 */
export function isGoFreeModel(id) {
  return id.endsWith("-free");
}

/**
 * 把目录里的等级列表展开成 dsh `reasoningEfforts` 映射。
 *
 * 返回 `false` 表示该模型不提供推理等级（dsh 会显示「当前模型未提供推理等级」）；
 * 否则返回 `{ off: null, <level>: "<wire>" }`，`off: null` 表示「不发送参数」。
 * 未知模型按非推理模型处理，避免给未核实的模型发出它不认识的参数。
 */
export function reasoningEfforts(id, catalog = CATALOG) {
  const levels = catalog[id]?.efforts;
  if (!Array.isArray(levels) || levels.length === 0) return false;
  const map = { off: null };
  for (const level of THINKING_LEVELS) {
    if (level !== "off" && levels.includes(level)) map[level] = level;
  }
  return map;
}

const VISION_HINT = /(^|[-_.])vl([-_.]|$)|vision|omni/i;

export function modelSpec(id, catalog = CATALOG) {
  const known = catalog[id];
  const image = known ? known.image : VISION_HINT.test(id);
  const spec = { id, name: known?.name ?? prettyName(id), input: image ? ["text", "image"] : ["text"] };
  if (known?.contextWindow) spec.contextWindow = known.contextWindow;
  if (known?.maxTokens) spec.maxTokens = known.maxTokens;
  spec.reasoningEfforts = reasoningEfforts(id, catalog);
  return spec;
}

/** Go 订阅通道的模型规格（目录数据见 {@link GO_CATALOG}）。 */
export function goModelSpec(id) {
  return modelSpec(id, GO_CATALOG);
}

export function modelObjects(ids, catalog = CATALOG, owner = "opencode") {
  const created = Math.floor(Date.now() / 1000);
  return ids.map((id) => {
    const spec = modelSpec(id, catalog);
    return {
      id,
      object: "model",
      created,
      owned_by: owner,
      name: spec.name,
      input: spec.input,
      reasoning: spec.reasoningEfforts !== false,
    };
  });
}
