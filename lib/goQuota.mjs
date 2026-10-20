/**
 * OpenCode Go 官方额度与价格（内置快照）。
 *
 * 数据来自 https://opencode.ai/docs/go/ 的 Usage limits 表：
 *   - 每个模型有「每月美元额度」，Go 与 Go Plus 两档；
 *   - 5 小时窗口 ≤ 月额度的 20%，周 ≤ 50%，月 ≤ 100%；
 *   - 价格按每 1M tokens（输入 / 输出 / 缓存读 / 缓存写）；
 *   - DeepSeek V4.1 Flash / V4 Pro 有峰谷价：
 *     Peak = 周一至周五 01:00-04:00、06:00-10:00 UTC，其余时间为 Off-Peak；
 *   - 部分模型按上下文长度分档计价（≤ / > 256K 等）。
 *
 * 月度额度/窗口是官方规则，金额是我们按 token 用量 × 官方价折算的「估算」，
 * 用于在桥里看还剩多少额度；官方账单与限流以 OpenCode 控制台为准。
 */

export const QUOTA_SOURCE = {
  url: "https://opencode.ai/docs/go/",
  updated: "2026-10-20",
};

export const PLANS = {
  go: { id: "go", name: "Go", priceMonthly: 10, label: "Go（$10/月）" },
  "go-plus": { id: "go-plus", name: "Go Plus", priceMonthly: 40, label: "Go Plus（$40/月）" },
};

export const PLAN_IDS = Object.keys(PLANS);

/** 5 小时 / 周 / 月 三个窗口占「月额度」的比例，来自官方规则。 */
export const WINDOW_RATIOS = { h5: 0.2, week: 0.5, month: 1 };

function price(input, output, cacheRead = null, cacheWrite = null) {
  return { input, output, cacheRead, cacheWrite };
}

function model(name, limits, tiers, extra = {}) {
  return { name, limits, tiers, ...extra };
}

/**
 * 33 个 Go 模型里官方价格表收录的部分。
 * 未收录（如 cat-jam-free / space-bunny）不参与额度换算，只在用过后按未知模型展示。
 */
export const GO_QUOTA_MODELS = {
  "glm-5.3-flash": model("GLM-5.3-Flash", { go: 60, "go-plus": 180 }, [price(0.15, 0.5, 0.03)]),
  "glm-5.3": model("GLM-5.3", { go: 15, "go-plus": 120 }, [price(1.4, 4.4, 0.26)]),
  "glm-5.2": model("GLM-5.2", { go: 60, "go-plus": 180 }, [price(1.4, 4.4, 0.26)]),
  "kimi-k3": model("Kimi K3", { go: 15, "go-plus": 60 }, [price(3, 15, 0.3)]),
  "kimi-k2.7-code": model("Kimi K2.7 Code", { go: 60, "go-plus": 180 }, [price(0.95, 4, 0.19)]),
  "longcat-2.0": model("LongCat-2.0", { go: 60, "go-plus": 240 }, [price(0.3, 1.2, 0.006)]),
  "longcat-2.5-preview-free": model("LongCat 2.5 Preview Free", null, [], { unlimited: true }),
  "step-5-preview": model("Step 5 Preview", { go: 15, "go-plus": 60 }, [price(1, 2.7, 0.1)], {
    note: "4x 限时",
  }),
  "beam-free": model("Beam Free", null, [], { unlimited: true }),
  "mimo-v2.6-flash": model("MiMo-V2.6-Flash", { go: 60, "go-plus": 120 }, [price(0.14, 0.28, 0.0028)]),
  "mimo-v2.6-pro": model("MiMo-V2.6-Pro", { go: 15, "go-plus": 60 }, [price(0.435, 0.87, 0.003625)]),
  "mimo-v2.5": model("MiMo-V2.5", { go: 60, "go-plus": 120 }, [price(0.14, 0.28, 0.0028)]),
  "mimo-v2.5-pro": model("MiMo-V2.5-Pro", { go: 15, "go-plus": 60 }, [price(0.435, 0.87, 0.003625)]),
  "minimax-m3.1-flash-free": model("MiniMax M3.1 Flash Free", null, [], { unlimited: true }),
  "minimax-m3": model("MiniMax M3", { go: 60, "go-plus": 180 }, [price(0.3, 1.2, 0.06)]),
  "muse-spark-1.3-contributor": model(
    "Muse Spark 1.3 Contributor",
    { go: 60, "go-plus": 120 },
    [price(0.1, 0.2, 0.002)],
  ),
  "muse-spark-1.2-contributor": model(
    "Muse Spark 1.2 Contributor",
    { go: 60, "go-plus": 120 },
    [price(0.1, 0.2, 0.002)],
  ),
  "qwen3.8-max": model("Qwen3.8 Max", { go: 15, "go-plus": 60 }, [price(2, 6, 0.25, 2.5)]),
  "qwen3.8-flash": model("Qwen3.8 Flash", { go: 30, "go-plus": 90 }, [price(0.15, 0.47, 0.016, 0.2)]),
  "qwen3.7-plus": model("Qwen3.7 Plus", { go: 60, "go-plus": 180 }, [
    { upTo: 256_000, ...price(0.4, 1.6, 0.04, 0.5) },
    { upTo: Infinity, ...price(1.2, 4.8, 0.12, 1.5) },
  ]),
  "deepseek-v4.1-flash": model("DeepSeek V4.1 Flash", { go: 80, "go-plus": 160 }, [price(0.15, 0.6, 0.003)], {
    peakTiers: [price(0.3, 1.2, 0.006)],
    note: "峰谷价",
  }),
  "deepseek-v4-pro": model("DeepSeek V4 Pro", { go: 15, "go-plus": 60 }, [price(0.66, 1.98, 0.022)], {
    peakTiers: [price(1.32, 3.96, 0.044)],
    note: "峰谷价",
  }),
  "hy4-preview": model("Hy4 preview", { go: 30, "go-plus": 120 }, [price(0.834, 2.501, 0.042)]),
  hy3: model("Hy3", { go: 60, "go-plus": 240 }, [price(0.14, 0.58, 0.035)]),
  "grok-4.7": model("Grok 4.7", { go: 15, "go-plus": 60 }, [
    { upTo: 200_000, ...price(2, 6, 0.5) },
    { upTo: Infinity, ...price(4, 12, 1) },
  ]),
  "gpt-6-luna": model("GPT-6 Luna", { go: 15, "go-plus": 60 }, [
    { upTo: 272_000, ...price(0.1, 0.5, 0.01, 0.125) },
    { upTo: Infinity, ...price(0.2, 0.75, 0.02, 0.25) },
  ]),
  "gpt-5.6-luna": model("GPT-5.6 Luna", { go: 15, "go-plus": 60 }, [
    { upTo: 272_000, ...price(0.2, 1.2, 0.02, 0.25) },
    { upTo: Infinity, ...price(0.4, 1.8, 0.04, 0.5) },
  ]),
  "claude-haiku-5-5": model("Claude Haiku 5.5", { go: 15, "go-plus": 60 }, [
    { upTo: 100_000, ...price(0.1, 0.5, 0.01, 0.125) },
    { upTo: Infinity, ...price(0.5, 2.5, 0.05, 0.625) },
  ]),
  "gemini-4-argon-contributor": model(
    "Gemini 4 Argon Contributor",
    { go: 30, "go-plus": 120 },
    [price(4, 20, 0.2)],
    { note: "2x 限时" },
  ),
};

export function planInfo(planId) {
  return PLANS[planId] ?? PLANS.go;
}

export function normalizePlan(planId) {
  return PLAN_IDS.includes(planId) ? planId : "go";
}

export function modelQuota(modelId) {
  return GO_QUOTA_MODELS[modelId] ?? null;
}

/** DeepSeek 峰谷价：周一至周五 01:00-04:00、06:00-10:00 UTC 为 Peak。 */
export function isPeak(at = Date.now()) {
  const d = new Date(at);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function chooseTier(tiers, contextTokens) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  for (const tier of tiers) {
    if (!tier.upTo || contextTokens <= tier.upTo) return tier;
  }
  return tiers[tiers.length - 1];
}

/** 返回某模型在指定时刻/上下文长度下适用的官方价格档（$/1M tokens）。 */
export function priceForGoModel(modelId, { promptTokens = 0, completionTokens = 0, at = Date.now() } = {}) {
  const entry = modelQuota(modelId);
  if (!entry) return null;
  const contextTokens = Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(completionTokens) || 0);
  const tiers = entry.peakTiers && isPeak(at) ? entry.peakTiers : entry.tiers;
  return chooseTier(tiers, contextTokens);
}

function usageParts(usage) {
  const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage?.completion_tokens) || 0);
  const details = usage?.prompt_tokens_details ?? {};
  const cached = Math.max(0, Number(details.cached_tokens) || 0);
  const cacheWrite = Math.max(0, Number(details.cache_write_tokens ?? usage?.cache_creation_input_tokens) || 0);
  return { prompt, completion, cached, cacheWrite };
}

/** 按官方 Go 价格把一次请求的 usage 折算成美元；模型不在表里返回 null。 */
export function goCostFor(modelId, usage, at = Date.now()) {
  const parts = usageParts(usage);
  const tier = priceForGoModel(modelId, { promptTokens: parts.prompt, completionTokens: parts.completion, at });
  if (!tier) return null;
  const cachedRead = tier.cacheRead ?? tier.input;
  const cachedWrite = tier.cacheWrite ?? tier.input;
  const fresh = Math.max(0, parts.prompt - parts.cached - parts.cacheWrite);
  return (
    (fresh * tier.input +
      parts.cached * cachedRead +
      parts.cacheWrite * cachedWrite +
      parts.completion * tier.output) /
    1_000_000
  );
}

/**
 * 生成额度列表：每个模型 5 小时 / 近 7 天 / 本月 的已用金额、剩余额度与百分比。
 * `usageMap` 来自 store.goUsageWindows()。
 */
export function quotaRows(planId, usageMap, now = Date.now()) {
  const plan = normalizePlan(planId);
  const rows = [];
  for (const [id, entry] of Object.entries(GO_QUOTA_MODELS)) {
    const used = usageMap.get(id) ?? { h5: 0, week: 0, month: 0, requests: 0, tokens: 0 };
    const limit = entry.unlimited ? null : (entry.limits?.[plan] ?? null);
    const h5Limit = limit === null ? null : limit * WINDOW_RATIOS.h5;
    const weekLimit = limit === null ? null : limit * WINDOW_RATIOS.week;
    rows.push({
      id,
      name: entry.name,
      note: entry.note ?? "",
      unlimited: limit === null,
      limit,
      h5Limit,
      weekLimit,
      h5: used.h5,
      week: used.week,
      month: used.month,
      requests: used.requests,
      tokens: used.tokens,
      remaining: limit === null ? null : Math.max(0, limit - used.month),
      h5Pct: h5Limit ? used.h5 / h5Limit : null,
      weekPct: weekLimit ? used.week / weekLimit : null,
      monthPct: limit ? used.month / limit : null,
      unknown: false,
      now,
    });
  }
  for (const [id, used] of usageMap) {
    if (GO_QUOTA_MODELS[id]) continue;
    rows.push({
      id,
      name: id,
      note: "官方价格表未收录",
      unlimited: false,
      limit: null,
      h5Limit: null,
      weekLimit: null,
      h5: used.h5,
      week: used.week,
      month: used.month,
      requests: used.requests,
      tokens: used.tokens,
      remaining: null,
      h5Pct: null,
      weekPct: null,
      monthPct: null,
      unknown: true,
      now,
    });
  }
  rows.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    if (a.unlimited !== b.unlimited) return a.unlimited ? 1 : -1;
    const usedA = a.month > 0;
    const usedB = b.month > 0;
    if (usedA !== usedB) return usedA ? -1 : 1;
    if (usedA) return (b.monthPct ?? 0) - (a.monthPct ?? 0);
    return a.name.localeCompare(b.name);
  });
  return rows;
}

/** 额度列表的汇总信息（面板标题用）。 */
export function quotaSummary(planId, rows) {
  const plan = planInfo(planId);
  let used = 0;
  let limit = 0;
  let h5 = 0;
  let week = 0;
  let active = 0;
  let unlimited = 0;
  for (const row of rows) {
    if (row.unknown) continue;
    if (row.unlimited) {
      unlimited += 1;
      continue;
    }
    if (!row.limit) continue;
    used += row.month;
    limit += row.limit;
    h5 += row.h5;
    week += row.week;
    if (row.month > 0) active += 1;
  }
  return { plan, used, limit, h5, week, active, unlimited };
}
