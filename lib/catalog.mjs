import { FALLBACK_GO_MODEL_IDS, GO_CATALOG, THINKING_LEVELS } from "./models.mjs";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const GO_PROVIDER_ID = "opencode-go";

const LADDER = THINKING_LEVELS.filter((level) => level !== "off");

/**
 * 从 models.dev 的 provider 目录推导推理等级。
 *
 * - `{ type: "effort", values }` → 只声明列出的等级（`none` 由 dsh 的 `off` 表达）；
 * - `{ type: "toggle" }` / `{ type: "budget_tokens" }` → 目录没有细分，按整条阶梯声明；
 * - 没有任何选项 → 同样按整条阶梯（与 Zen 目录 `[]` 的处理保持一致）。
 */
export function effortsFromOptions(reasoningOptions) {
  const levels = new Set();
  for (const option of reasoningOptions ?? []) {
    if (option?.type === "effort" && Array.isArray(option.values)) {
      for (const value of option.values) if (value !== "none") levels.add(value);
    } else if (option?.type === "toggle" || option?.type === "budget_tokens") {
      for (const level of LADDER) levels.add(level);
    }
  }
  if (levels.size === 0) for (const level of LADDER) levels.add(level);
  return LADDER.filter((level) => levels.has(level));
}

/**
 * 把 models.dev 的 `opencode-go.models` 转成与 {@link GO_CATALOG} 同构的目录。
 *
 * 返回 `{ ids, catalog }`；models.dev 数据缺失时返回 `null`，调用方回退静态目录。
 */
export function buildGoCatalog(api) {
  const models = api?.[GO_PROVIDER_ID]?.models;
  if (!models || typeof models !== "object") return null;
  const catalog = {};
  const ids = [];
  for (const [id, model] of Object.entries(models)) {
    ids.push(id);
    const entry = {
      name: model?.name ?? id,
      image: Boolean(model?.attachment),
    };
    const context = Number(model?.limit?.context);
    const output = Number(model?.limit?.output);
    if (Number.isFinite(context) && context > 0) entry.contextWindow = context;
    if (Number.isFinite(output) && output > 0) entry.maxTokens = output;
    entry.efforts = model?.reasoning ? effortsFromOptions(model?.reasoning_options) : false;
    catalog[id] = entry;
  }
  return ids.length > 0 ? { ids, catalog } : null;
}

/** 拉取 models.dev 目录（失败抛错，由调用方决定回退）。 */
export async function fetchModelsDev(cfg) {
  const res = await fetch(MODELS_DEV_URL, {
    headers: { "user-agent": cfg.ua, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  return res.json();
}

/**
 * 获取 Go 模型列表：先问本桥（若已在运行），再问 models.dev，最后用内置回退。
 *
 * 返回 `{ ids, catalog }`，`catalog` 用于生成 dsh 的模型能力字段。
 */
export async function fetchGoCatalog(cfg) {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/go/v1/models`, {
      headers: { "user-agent": cfg.ua, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json();
      const ids = (json.data ?? []).map((model) => model.id);
      if (ids.length > 0) return { ids, catalog: GO_CATALOG };
    }
  } catch {}
  try {
    const built = buildGoCatalog(await fetchModelsDev(cfg));
    if (built) return built;
  } catch {}
  return { ids: FALLBACK_GO_MODEL_IDS, catalog: GO_CATALOG };
}
