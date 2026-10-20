const PRICING_URL = "https://models.dev/api.json";
export const PRICING_SOURCE = "models.dev";
const PRICING_TTL_MS = 10 * 60 * 1000;
const PRICING_RETRY_MS = 60 * 1000;

const MANUAL = {
  "jev-1.13-free": { input: 0.042, output: 0, cache_read: 0, source: "zen-docs" },
};

const ALIASES = {
  "deepseek-v4.1-flash-free": [["opencode", "deepseek-v4.1-flash"]],
  "glm-5.3-flash-free": [["opencode", "glm-5.3-flash"]],
  "minimax-m3.1-flash-free": [
    ["minimax", "MiniMax-M3.1-Flash"],
    ["minimax-cn", "MiniMax-M3.1-Flash"],
    ["openrouter", "minimax/minimax-m3.1-flash"],
  ],
  "mimo-v2.6-flash-free": [
    ["opencode-go", "mimo-v2.6-flash"],
    ["xiaomi", "mimo-v2.6-flash"],
    ["openrouter", "xiaomi/mimo-v2.6-flash"],
  ],
  "space-bunny-free": [["opencode-go", "space-bunny"]],
  "nemotron-3.5-super-vl-free": [
    ["openrouter", "nvidia/nemotron-3.5-super-vl"],
    ["vercel", "nvidia/nemotron-3.5-super-vl"],
  ],
  "nemotron-3.5-lightning-free": [
    ["openrouter", "nvidia/nemotron-3.5-lightning"],
    ["vercel", "nvidia/nemotron-3.5-lightning"],
  ],
  "longcat-2.5-preview-free": [
    ["nano-gpt", "longcat-2.5-preview"],
    ["openrouter", "longcat/longcat-2.5-preview"],
  ],
  "beam-free": [
    ["openrouter", "reflection/beam-1.0-501b-a23b"],
    ["vercel", "reflection/beam-1.0-501b-a23b"],
  ],
  "glm-5-free": [["opencode", "glm-5"]],
  "glm-4.7-free": [["opencode", "glm-4.7"]],
  "minimax-m3-free": [["opencode", "minimax-m3"]],
  "minimax-m2.5-free": [["opencode", "minimax-m2.5"]],
  "minimax-m2.1-free": [["opencode", "minimax-m2.1"]],
  "qwen3.6-plus-free": [["opencode", "qwen3.6-plus"]],
  "kimi-k2.5-free": [["opencode", "kimi-k2.5"]],
  "longcat-2.0-free": [["opencode-go", "longcat-2.0"]],
  "mimo-v2.5-free": [["xiaomi", "mimo-v2.5"]],
  "mimo-v2.5-pro-free": [["xiaomi", "mimo-v2.5-pro"]],
  "nemotron-3-ultra-free": [["openrouter", "nvidia/nemotron-3-ultra-550b-a55b"]],
  "nemotron-3-super-free": [["openrouter", "nvidia/nemotron-3-super-120b-a12b"]],
};

const PREFERRED_PROVIDERS = [
  "opencode",
  "opencode-go",
  "openrouter",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "nvidia",
  "zai",
  "z-ai",
  "deepseek",
  "longcat",
  "moonshotai",
  "vercel",
  "pioneer",
  "nano-gpt",
  "cloudflare",
];

export function createPricingState() {
  return { map: new Map(), at: 0, error: null, attemptedAt: 0 };
}

function toPrice(model, source) {
  const cost = model?.cost;
  if (!cost || typeof cost !== "object") return null;
  const input = Number(cost.input);
  const output = Number(cost.output);
  const cacheRead = Number(cost.cache_read ?? cost.cache_read_input_tokens ?? input);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input === 0 && output === 0) return null;
  return {
    input,
    output,
    cache_read: Number.isFinite(cacheRead) ? cacheRead : input,
    source,
  };
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bfree\b/g, "")
    .replace(/[^a-z0-9.]+/g, "");
}

function buildIndex(api) {
  const byProvider = new Map();
  const providers = [];
  for (const [providerId, provider] of Object.entries(api ?? {})) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    byProvider.set(providerId, models);
    providers.push(providerId);
  }
  const order = [
    ...PREFERRED_PROVIDERS.filter((id) => byProvider.has(id)),
    ...providers.filter((id) => !PREFERRED_PROVIDERS.includes(id)).sort(),
  ];
  const byName = new Map();
  for (const providerId of order) {
    for (const [modelId, model] of Object.entries(byProvider.get(providerId))) {
      const name = normalizeName(model?.name ?? modelId);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ providerId, modelId, model });
    }
  }
  return { byProvider, byName, order };
}

function resolvePrice(id, index) {
  const manual = MANUAL[id];
  if (manual) return { ...manual };

  for (const [providerId, modelId] of ALIASES[id] ?? []) {
    const model = index.byProvider.get(providerId)?.[modelId];
    const price = toPrice(model, `${providerId}/${modelId}`);
    if (price) return price;
  }

  const base = id.replace(/-free$/, "");
  for (const providerId of index.order) {
    const model = index.byProvider.get(providerId)?.[base];
    const price = toPrice(model, `${providerId}/${base}`);
    if (price) return price;
  }

  const target = normalizeName(base);
  for (const candidate of index.byName.get(target) ?? []) {
    const price = toPrice(candidate.model, `${candidate.providerId}/${candidate.modelId}`);
    if (price) return price;
  }

  return null;
}

export async function refreshPricing(cfg, pricing, ids, { force = false } = {}) {
  const now = Date.now();
  const cooldown = pricing.error ? PRICING_RETRY_MS : PRICING_TTL_MS;
  if (!force && pricing.attemptedAt && now - pricing.attemptedAt < cooldown) {
    return { updated: false, ok: pricing.error === null, error: pricing.error };
  }
  pricing.attemptedAt = now;

  let api;
  try {
    const res = await fetch(PRICING_URL, {
      headers: { "user-agent": cfg.ua, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    api = await res.json();
  } catch (error) {
    pricing.error = String(error?.message ?? error);
    return { updated: true, ok: false, error: pricing.error };
  }

  const index = buildIndex(api);
  const map = new Map();
  const wanted = new Set([...ids, ...Object.keys(ALIASES), ...Object.keys(MANUAL)]);
  for (const id of wanted) {
    const price = resolvePrice(id, index);
    if (price) map.set(id, price);
  }
  pricing.map = map;
  pricing.at = Date.now();
  pricing.error = null;
  return { updated: true, ok: true, error: null, priced: map.size };
}

export function priceFor(pricing, id) {
  return pricing.map.get(id) ?? null;
}

export function computeCost(usage, price) {
  if (!usage || !price) return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
  const uncached = Math.max(0, prompt - cached);
  const inputRate = Number(price.input) || 0;
  const cacheRate = Number.isFinite(price.cache_read) ? price.cache_read : inputRate;
  const outputRate = Number(price.output) || 0;
  return (uncached * inputRate + cached * cacheRate + completion * outputRate) / 1_000_000;
}
