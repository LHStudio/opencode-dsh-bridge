import http from "node:http";
import { buildGoCatalog, fetchModelsDev } from "./catalog.mjs";
import { goCostFor, normalizePlan, quotaRows } from "./goQuota.mjs";
import { agentHeaders, conversationSession, goHeaders, sessionId } from "./identity.mjs";
import {
  FALLBACK_GO_MODEL_IDS,
  FALLBACK_MODEL_IDS,
  GO_CATALOG,
  isFreeModel,
  modelObjects,
  modelSpec,
} from "./models.mjs";
import {
  PRICING_SOURCE,
  computeCost,
  createPricingState,
  priceFor,
  refreshPricing,
} from "./pricing.mjs";
import { DEFAULT_MODELS, PROVIDERS, goEnabled, setDefaultModel, syncPatchFiles } from "./setup.mjs";
import {
  allTimeTotals,
  appendUsage,
  configureDataDir,
  dailySummary,
  dataPaths,
  goUsageWindows,
  loadState,
  pruneUsage,
  saveGoKey,
  saveState,
  savedGoKey,
  todayTotals,
} from "./store.mjs";
import {
  ICONS,
  bold,
  createStatus,
  cyan,
  dim,
  enableDashboard,
  formatCount,
  formatMoney,
  gray,
  green,
  line,
  recordRequest,
  red,
  stopDashboard,
  stopStatus,
  updateDashboardMeta,
  yellow,
} from "./ui.mjs";

const MODELS_TTL_MS = 5 * 60 * 1000;
const GO_MODELS_TTL_MS = 30 * 60 * 1000;
const BODY_LIMIT = 64 * 1024 * 1024;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000;

const NOOP_STRIPPER = { sanitizeChunk: (obj) => obj };

const GATE_TOOL_NAME = "read";

const GATE_TOOL = {
  type: "function",
  function: {
    name: GATE_TOOL_NAME,
    description: "Read a file from the local filesystem",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file to read" },
      },
      required: ["filePath"],
    },
  },
};

function createToolStripper(stripAll, injectedNames) {
  const blocked = new Set();
  let sawClientCall = false;
  return {
    sanitizeChunk(obj) {
      const choice = obj?.choices?.[0];
      if (!choice) return obj;
      const delta = choice.delta;
      if (delta && Array.isArray(delta.tool_calls)) {
        if (stripAll) {
          delete delta.tool_calls;
        } else {
          const kept = [];
          for (const call of delta.tool_calls) {
            const index = call.index ?? 0;
            const name = call.function?.name;
            if (name && injectedNames.has(name)) blocked.add(index);
            if (blocked.has(index)) continue;
            sawClientCall = true;
            kept.push(call);
          }
          if (kept.length === 0) delete delta.tool_calls;
          else delta.tool_calls = kept;
        }
      }
      if (choice.finish_reason === "tool_calls" && !sawClientCall) choice.finish_reason = "stop";
      return obj;
    },
    get sawClientCall() {
      return sawClientCall;
    },
  };
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-session-id");
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function errorBody(message, type = "bridge_error") {
  return { error: { message, type } };
}

function isAbortError(error) {
  const message = String(error?.message ?? "");
  return error?.name === "AbortError" || /aborted|aborterror/i.test(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function syncProfiles(cfg, state, ids) {
  if (!cfg.sync) return;
  const prevIds = state.prevIds;
  const goIds = state.goIds ?? [];
  try {
    const results = await syncPatchFiles(cfg, { freeIds: ids, goIds });
    const changed = results.filter((result) => result.changed);
    if (changed.length === 0) return;
    const prevGoIds = state.prevGoIds ?? [];
    const added = prevIds === null ? [] : ids.filter((id) => !prevIds.includes(id));
    const removed = prevIds === null ? [] : prevIds.filter((id) => !ids.includes(id));
    const addedGo = prevGoIds === null ? [] : goIds.filter((id) => !prevGoIds.includes(id));
    const diff = [
      added.length ? `新增 ${added.join(", ")}` : null,
      removed.length ? `移除 ${removed.join(", ")}` : null,
      addedGo.length ? `Go 新增 ${addedGo.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("，");
    line(
      cfg,
      `${ICONS.sync} ${yellow("检测到模型列表变化")}${diff ? dim(`（${diff}）`) : ""}，` +
        `已重写配置：${changed.map((result) => result.profile).join("、")}` +
        `${dim("（重启 DSH 后生效）")}`,
    );
  } catch (error) {
    line(cfg, `${ICONS.warn} ${yellow("同步模型列表失败")}：${error.message}`);
  }
}

async function getFreeModels(cfg, state, force = false) {
  const now = Date.now();
  if (!force && state.models && now - state.modelsAt < MODELS_TTL_MS) return state.models;
  try {
    const res = await fetch(cfg.modelsUrl, {
      headers: { "user-agent": cfg.ua, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = await res.json();
      const ids = (json.data ?? [])
        .map((model) => model.id)
        .filter((id) => isFreeModel(id, cfg.extraFree));
      if (ids.length > 0) {
        const firstLoad = state.models === null;
        state.models = modelObjects(ids);
        state.modelsAt = now;
        state.ids = ids;
        updateDashboardMeta({ modelCount: ids.length });
        void ensurePricing(cfg, state).catch(() => {});
        await syncProfiles(cfg, state, ids);
        state.prevIds = ids;
        if (firstLoad) {
          line(cfg, `${ICONS.bolt} 免费模型 ${bold(String(ids.length))} 个已就绪${dim(`：${ids.join(", ")}`)}`);
        }
        return state.models;
      }
    }
  } catch {}
  if (state.models) return state.models;
  state.prevIds = FALLBACK_MODEL_IDS;
  state.ids = FALLBACK_MODEL_IDS;
  const fallback = modelObjects(FALLBACK_MODEL_IDS);
  updateDashboardMeta({ modelCount: fallback.length });
  void ensurePricing(cfg, state).catch(() => {});
  return fallback;
}

/**
 * 加载 Go 订阅通道的模型目录。
 *
 * Go 上游没有 `/models` 端点（实测 404），目录来自 models.dev 的 `opencode-go`
 * provider；拉取失败时退回内置静态目录，保证离线也能用。
 */
async function getGoModels(cfg, state, force = false) {
  if (!goEnabled(cfg)) {
    state.goModels = null;
    return null;
  }
  const now = Date.now();
  if (!force && state.goModels && now - state.goAt < GO_MODELS_TTL_MS) return state.goModels;
  let ids = FALLBACK_GO_MODEL_IDS;
  let catalog = GO_CATALOG;
  try {
    const built = buildGoCatalog(await fetchModelsDev(cfg));
    if (built) {
      ids = built.ids;
      catalog = built.catalog;
    }
  } catch {}
  const firstLoad = state.goModels === null;
  state.goCatalog = catalog;
  state.goIds = ids;
  state.goModels = modelObjects(ids, catalog, PROVIDERS.go.id);
  state.goAt = now;
  updateDashboardMeta({ goModelCount: ids.length, goReady: true });
  void ensurePricing(cfg, state).catch(() => {});
  await syncProfiles(cfg, state, state.ids ?? FALLBACK_MODEL_IDS);
  state.prevGoIds = ids;
  if (firstLoad) {
    line(
      cfg,
      `${ICONS.bolt} Go 订阅模型 ${bold(String(ids.length))} 个已就绪` +
        `${cfg.goKey ? "" : dim("（未配 Go 密钥，请求会被上游拒绝）")}`,
    );
  }
  return state.goModels;
}

function allModelIds(state) {
  return [...(state.ids ?? []), ...(state.goIds ?? [])];
}

async function ensurePricing(cfg, state) {
  const ids = allModelIds(state);
  if (ids.length === 0) return null;
  const result = await refreshPricing(cfg, state.pricing, ids);
  const pricing = state.pricing;
  updateDashboardMeta({
    pricingSource: PRICING_SOURCE,
    pricingAt: pricing.at,
    pricingOk: pricing.error ? false : pricing.at ? true : null,
  });
  if (result.updated && !result.ok) {
    if (!state.pricingWarned) {
      state.pricingWarned = true;
      line(
        cfg,
        `${ICONS.warn} ${yellow("计价数据更新失败")}：${dim(result.error)}` +
          `${pricing.at ? dim("（沿用上次价格）") : ""}`,
      );
    }
  } else if (result.ok) {
    state.pricingWarned = false;
  }
  return result;
}

function upstreamHeaders(cfg, state, tier, session) {
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (tier === "go") {
    Object.assign(headers, goHeaders(cfg, session));
    if (cfg.goKey) headers.authorization = `Bearer ${cfg.goKey}`;
    return headers;
  }
  Object.assign(headers, agentHeaders(cfg, state.session));
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  return headers;
}

/**
 * Go 通道的会话 ID：客户端自带 `x-session-id` 就用它（dsh 打开会话亲和时），
 * 否则用对话内容推导，保证同一段对话始终落在同一个会话上。
 */
function clientSession(req, body) {
  const header = req.headers["x-session-id"] ?? req.headers["x-opencode-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return conversationSession(body);
}

function summarizeBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return errorBody(text.slice(0, 500) || "upstream error", "upstream_error");
  }
}

function upstreamDetail(text) {
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message ?? json?.message ?? json?.error ?? "";
    return String(message).replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return String(text ?? "").replace(/\s+/g, " ").slice(0, 200);
  }
}

function statusHint(status, tier = "free") {
  if (status === 401 && tier === "go") return "Go 凭据无效或未配置";
  if (status === 403) return tier === "go" ? "Go 订阅拒绝" : "免费层拒绝";
  if (status === 429) return "请求过于频繁";
  if (status === 504) return "上游超时";
  if (status >= 500) return "上游错误";
  return "上游拒绝";
}

function parseSseLine(line) {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function isUsageOnlyChunk(obj) {
  return Boolean(obj?.usage) && (!Array.isArray(obj.choices) || obj.choices.length === 0);
}

function createStats() {
  return {
    contentChars: 0,
    reasoningChars: 0,
    toolIndices: new Set(),
    usage: null,
    firstByteAt: null,
  };
}

function resetStats(stats) {
  stats.contentChars = 0;
  stats.reasoningChars = 0;
  stats.toolIndices.clear();
  stats.usage = null;
  stats.firstByteAt = null;
}

function trackChunk(obj, stats) {
  const choice = obj?.choices?.[0];
  if (choice) {
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") stats.contentChars += delta.content.length;
    if (typeof delta.reasoning_content === "string") {
      stats.reasoningChars += delta.reasoning_content.length;
    }
    if (typeof delta.reasoning === "string") stats.reasoningChars += delta.reasoning.length;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) stats.toolIndices.add(call.index ?? 0);
    }
  }
  if (obj?.usage) stats.usage = obj.usage;
}

function progressText(model, stats, started) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const parts = [bold(model), dim(`${seconds}s`)];
  const sawData = stats.firstByteAt !== null;
  if (!sawData) {
    parts.push(dim("连接中"));
  } else if (stats.contentChars === 0 && stats.reasoningChars === 0 && stats.toolIndices.size === 0) {
    parts.push(dim("等待首字"));
  } else {
    if (stats.reasoningChars) parts.push(dim(`思考 ${formatCount(stats.reasoningChars)} 字`));
    if (stats.contentChars) parts.push(dim(`输出 ${formatCount(stats.contentChars)} 字`));
    if (stats.toolIndices.size) parts.push(dim(`工具 ${stats.toolIndices.size}`));
  }
  return parts.join(" · ");
}

function usageText(usage) {
  if (!usage) return "";
  const input = Number(usage.prompt_tokens);
  const output = Number(usage.completion_tokens);
  const total = Number(usage.total_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return "";
  const parts = [];
  if (Number.isFinite(input)) parts.push(`输入 ${formatCount(input)}`);
  if (Number.isFinite(output)) parts.push(`输出 ${formatCount(output)}`);
  if (Number.isFinite(total)) parts.push(`共 ${formatCount(total)}`);
  if (parts.length === 0) return "";
  return `${dim("·")} ${parts.join(" · ")} ${dim("tokens")}`;
}

function statsText(stats) {
  const parts = [];
  if (stats.reasoningChars) parts.push(`思考 ${formatCount(stats.reasoningChars)} 字`);
  if (stats.contentChars) parts.push(`输出 ${formatCount(stats.contentChars)} 字`);
  if (stats.toolIndices.size) parts.push(`工具 ${stats.toolIndices.size}`);
  return parts.length ? `${dim("·")} ${parts.join(" · ")}` : "";
}

function successText(model, requestedModel, stats, started, costInfo = null) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const via = model === requestedModel ? "" : dim(`（回退自 ${requestedModel}）`);
  const usage = usageText(stats.usage);
  const cost = costInfo?.priced ? ` ${dim("·")} ${green(`≈${formatMoney(costInfo.cost)}`)}` : "";
  return (
    `${green(ICONS.arrow)} ${bold(model)} ${dim(`· ${seconds}s`)} ${green(ICONS.ok)}` +
    ` ${usage || statsText(stats)}${cost}${via}`
  );
}

function cancelText(model, started) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return `${yellow(ICONS.cancel)} ${bold(model)} ${dim(`· ${seconds}s · 客户端已断开`)}`;
}

async function collectCompletion(stream, stripper, onChunk, onActivity) {
  const decoder = new TextDecoder();
  const message = { role: "assistant", content: "" };
  let frame = { id: undefined, created: undefined, model: undefined };
  let finish = "stop";
  let usage = null;
  let buffer = "";

  const consume = (line) => {
    const chunk = parseSseLine(line);
    if (!chunk) return;
    frame.id ??= chunk.id;
    frame.created ??= chunk.created;
    frame.model ??= chunk.model;
    stripper.sanitizeChunk(chunk);
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") message.content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        message.reasoning_content = (message.reasoning_content ?? "") + delta.reasoning_content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) mergeToolCall(message, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (chunk.usage) usage = chunk.usage;
    onChunk?.(chunk);
  };

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) consume(buffer);

  if (finish === "tool_calls" && !stripper.sawClientCall) finish = "stop";
  if (message.tool_calls?.length === 0) delete message.tool_calls;

  return {
    id: frame.id ?? "chatcmpl-bridge",
    object: "chat.completion",
    created: frame.created ?? Math.floor(Date.now() / 1000),
    model: frame.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

function mergeToolCall(message, deltaCall) {
  const index = deltaCall.index ?? 0;
  if (!message.tool_calls) message.tool_calls = [];
  const current = (message.tool_calls[index] ??= {
    id: deltaCall.id,
    type: "function",
    function: { name: "", arguments: "" },
  });
  if (deltaCall.id) current.id = deltaCall.id;
  if (deltaCall.function?.name) current.function.name += deltaCall.function.name;
  if (deltaCall.function?.arguments) current.function.arguments += deltaCall.function.arguments;
}

async function pipeStream(upstreamRes, res, stripper, options) {
  const { servedBy, injected, clientWantsUsage, onChunk, onActivity } = options;
  const decoder = new TextDecoder();
  const reader = upstreamRes.body.getReader();
  let buffer = "";
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-bridge-model": servedBy,
      "x-bridge-injected-tools": injected,
    });
    res.flushHeaders?.();
  };

  const emit = (line, obj) => {
    if (!obj) {
      start();
      res.write(line + "\n");
      return;
    }
    stripper.sanitizeChunk(obj);
    onChunk?.(obj);
    if (isUsageOnlyChunk(obj) && !clientWantsUsage) return;
    start();
    res.write("data: " + JSON.stringify(obj) + "\n");
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        emit(buffer.slice(0, index), parseSseLine(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    }
    if (buffer) emit(buffer, parseSseLine(buffer));
    start();
    res.end();
  } catch (error) {
    if (started) {
      try {
        res.end();
      } catch {}
      error.committed = true;
    }
    throw error;
  }
}

async function handleChat(req, res, cfg, state, tier = "free") {
  const started = Date.now();
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, errorBody("invalid JSON request body", "invalid_request_error"));
    return;
  }
  const requestedModel = body.model;
  if (!requestedModel || typeof requestedModel !== "string") {
    sendJson(res, 400, errorBody("model is required", "invalid_request_error"));
    return;
  }

  const goChannel = tier === "go";
  let ids;
  if (goChannel) {
    if (!cfg.goKey) {
      line(
        cfg,
        `${ICONS.warn} ${yellow("Go 通道缺少凭据")} ${dim("· 设置 --go-key 或 OPENCODE_GO_API_KEY 后重启桥")}`,
      );
      appendUsage({
        ts: Date.now(),
        tier,
        model: requestedModel,
        outcome: "fail",
        prompt: 0,
        completion: 0,
        cached: 0,
        cost: 0,
        priced: true,
      });
      sendJson(
        res,
        400,
        errorBody(
          "OpenCode Go requires a credential: start the bridge with --go-key or OPENCODE_GO_API_KEY",
          "go_credential_missing",
        ),
      );
      return;
    }
    const goModels = (await getGoModels(cfg, state)) ?? [];
    ids = goModels.map((model) => model.id);
    if (!ids.includes(requestedModel)) {
      if (state.ids?.includes(requestedModel)) {
        sendJson(
          res,
          403,
          errorBody(
            `model '${requestedModel}' is a free-tier model; call it through the ${PROVIDERS.free.id} provider (/v1) instead`,
            "model_not_allowed",
          ),
        );
        return;
      }
      sendJson(
        res,
        403,
        errorBody(
          `model '${requestedModel}' is not in the OpenCode Go catalog; go models: ${ids.join(", ")}`,
          "model_not_allowed",
        ),
      );
      return;
    }
  } else {
    const freeModels = await getFreeModels(cfg, state);
    ids = freeModels.map((model) => model.id);
    if (!ids.includes(requestedModel) && !cfg.allowPaid) {
      const goModel = (state.goIds ?? []).includes(requestedModel);
      line(cfg, `${ICONS.warn} ${yellow("已拦截非免费模型")} ${bold(requestedModel)}`);
      sendJson(
        res,
        403,
        errorBody(
          `model '${requestedModel}' is not a free model` +
            (goModel
              ? `; it is an OpenCode Go model, use the ${PROVIDERS.go.id} provider (/go/v1) instead`
              : `; free models: ${ids.join(", ")}`),
          "model_not_allowed",
        ),
      );
      return;
    }
  }

  const clientStream = body.stream === true;
  const upstreamBody = { ...body, stream: true };

  // 免费层需要注入 `read` 工具作为门禁；Go 通道不需要，客户端工具原样透传。
  const clientTools = Array.isArray(body.tools) ? body.tools : [];
  let injectedNames = new Set();
  let stripAll = false;
  let injectedLabel = "none";
  if (!goChannel) {
    const hasGateTool = clientTools.some((tool) => tool?.function?.name === GATE_TOOL_NAME);
    if (!hasGateTool) injectedNames.add(GATE_TOOL_NAME);
    stripAll = clientTools.length === 0;
    injectedLabel = injectedNames.size === 0 ? "none" : stripAll ? "all" : "gate";
    upstreamBody.tools = hasGateTool ? clientTools : [...clientTools, GATE_TOOL];
  }

  const clientWantsUsage = clientStream && body.stream_options?.include_usage === true;
  upstreamBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

  const candidates = [requestedModel];
  if (cfg.fallback) {
    for (const id of ids) {
      if (id !== requestedModel && candidates.length < MAX_ATTEMPTS) candidates.push(id);
    }
  }

  const session = goChannel ? clientSession(req, body) : state.session;

  const status = createStatus(cfg);
  const stats = createStats();
  let recorded = false;
  const finishStatus = (text, outcome, extra = {}) => {
    if (!recorded) {
      recorded = true;
      const usage = outcome === "ok" ? stats.usage : null;
      recordRequest({ outcome, usage, tier, ...extra });
      // 持久化账本：一次请求一条，重启后仍能看每日请求次数 / 白嫖 / Go 花费。
      appendUsage({
        ts: Date.now(),
        tier,
        model: lastModel,
        outcome,
        prompt: Number(usage?.prompt_tokens) || 0,
        completion: Number(usage?.completion_tokens) || 0,
        cached: Number(usage?.prompt_tokens_details?.cached_tokens) || 0,
        cost: Number.isFinite(extra.costUsd) ? extra.costUsd : 0,
        priced: Boolean(extra.priced),
      });
    }
    status.finish(text);
  };
  const progressFor = (attempt) => () => progressText(attempt, stats, started);
  const touch = () => {
    lastActivity = Date.now();
  };

  let clientGone = false;
  let current = null;
  let idleFired = false;
  let lastActivity = Date.now();

  const idleWatch = setInterval(() => {
    if (Date.now() - lastActivity >= UPSTREAM_IDLE_TIMEOUT_MS) {
      idleFired = true;
      current?.abort();
    }
  }, 1000);
  idleWatch.unref?.();

  res.on("close", () => {
    if (res.writableEnded) return;
    clientGone = true;
    current?.abort();
  });

  const onChunk = (attempt) => (obj) => {
    stats.firstByteAt ??= Date.now();
    trackChunk(obj, stats);
    status.update(progressFor(attempt));
  };

  let attempts = 0;
  let modelIndex = 0;
  let sameRetries = 0;
  let lastStatus = 502;
  let lastBody = errorBody("no upstream attempt was made");
  let lastDetail = "";
  let lastModel = requestedModel;

  try {
    while (attempts < MAX_ATTEMPTS) {
      if (clientGone) {
        finishStatus(cancelText(lastModel, started), "cancel");
        return;
      }
      const attempt = candidates[modelIndex] ?? requestedModel;
      attempts += 1;
      lastModel = attempt;
      resetStats(stats);
      idleFired = false;
      touch();
      const controller = new AbortController();
      current = controller;
      status.update(progressFor(attempt));

      let response = null;
      let failure = null;

      try {
        response = await fetch(`${goChannel ? cfg.goUpstream : cfg.upstream}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders(cfg, state, tier, session),
          body: JSON.stringify({ ...upstreamBody, model: attempt }),
          signal: controller.signal,
        });
      } catch (error) {
        current = null;
        if (clientGone) {
          finishStatus(cancelText(attempt, started), "cancel");
          return;
        }
        failure = idleFired
          ? {
              status: 504,
              body: errorBody(
                `upstream sent no data for ${Math.round(UPSTREAM_IDLE_TIMEOUT_MS / 1000)}s`,
                "upstream_timeout",
              ),
              detail: `${Math.round(UPSTREAM_IDLE_TIMEOUT_MS / 1000)} 秒无数据`,
            }
          : {
              status: 502,
              body: errorBody(`upstream request failed: ${error.message}`, "upstream_error"),
              detail: error.message,
            };
      }

      if (response && response.status === 200) {
        const stripper = goChannel ? NOOP_STRIPPER : createToolStripper(stripAll, injectedNames);
        try {
          if (clientStream) {
            await pipeStream(response, res, stripper, {
              servedBy: attempt,
              injected: injectedLabel,
              clientWantsUsage,
              onChunk: onChunk(attempt),
              onActivity: touch,
            });
          } else {
            const completion = await collectCompletion(
              response.body,
              stripper,
              onChunk(attempt),
              touch,
            );
            completion.model ??= attempt;
            res.setHeader("x-bridge-model", attempt);
            res.setHeader("x-bridge-injected-tools", injectedLabel);
            sendJson(res, 200, completion);
          }
          current = null;
          const price = priceFor(state.pricing, attempt);
          // Go 通道必须用官方 Go 额度价折算（免费模型 / 峰谷价 / 长上下文分档都在 goQuota 里）；
          // 官方价格表未收录的模型宁可不计价，也不拿 Zen 价冒充 Go 账单。
          const cost =
            stats.usage && tier === "go"
              ? goCostFor(attempt, stats.usage)
              : stats.usage && price
                ? computeCost(stats.usage, price)
                : null;
          finishStatus(
            successText(attempt, requestedModel, stats, started, { cost, priced: cost !== null }),
            "ok",
            { priced: cost !== null, costUsd: cost },
          );
          return;
        } catch (error) {
          current = null;
          if (clientGone) {
            finishStatus(cancelText(attempt, started), "cancel");
            return;
          }
          if (error.committed) {
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            finishStatus(
              `${red(ICONS.fail)} ${bold(attempt)} ${dim(`· ${seconds}s`)} ${red("流式中断")}` +
                (idleFired ? dim(` · ${Math.round(UPSTREAM_IDLE_TIMEOUT_MS / 1000)} 秒无数据`) : ""),
              "fail",
            );
            if (!res.writableEnded) {
              try {
                res.end();
              } catch {}
            }
            return;
          }
          failure = idleFired
            ? {
                status: 504,
                body: errorBody(
                  `upstream sent no data for ${Math.round(UPSTREAM_IDLE_TIMEOUT_MS / 1000)}s`,
                  "upstream_timeout",
                ),
                detail: `${Math.round(UPSTREAM_IDLE_TIMEOUT_MS / 1000)} 秒无数据`,
              }
            : {
                status: 502,
                body: errorBody(`upstream stream failed: ${error.message}`, "upstream_error"),
                detail: error.message,
              };
        }
      } else if (response) {
        let text = "";
        try {
          text = await response.text();
        } catch (error) {
          if (clientGone) {
            finishStatus(cancelText(attempt, started), "cancel");
            return;
          }
          failure = {
            status: 502,
            body: errorBody(`upstream response failed: ${error.message}`, "upstream_error"),
            detail: error.message,
          };
        }
        if (!failure) {
          lastBody = summarizeBody(text);
          failure = { status: response.status, body: lastBody, detail: upstreamDetail(text) };
        }
      }

      lastStatus = failure.status;
      lastBody = failure.body;
      lastDetail = failure.detail;
      line(
        cfg,
        `${yellow(ICONS.warn)} ${bold(attempt)} ${dim("·")} ${yellow(`${lastStatus} ${statusHint(lastStatus, tier)}`)}` +
          `${lastDetail ? dim(` · ${lastDetail}`) : ""}`,
      );

      const canRetry = attempts < MAX_ATTEMPTS;
      if (canRetry && sameRetries < 1 && RETRY_STATUS.has(lastStatus)) {
        sameRetries += 1;
        const delay = lastStatus === 429 ? 1500 : 800;
        line(
          cfg,
          dim(`  ${(delay / 1000).toFixed(1)}s 后重试 ${attempt}（第 ${attempts + 1}/${MAX_ATTEMPTS} 次）`),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (canRetry && cfg.fallback && modelIndex + 1 < candidates.length) {
        modelIndex += 1;
        sameRetries = 0;
        line(cfg, dim(`  → 回退到 ${candidates[modelIndex]}`));
        continue;
      }
      break;
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    finishStatus(
      `${red(ICONS.fail)} ${bold(lastModel)} ${dim(`· ${seconds}s`)} ${red(`HTTP ${lastStatus}`)}` +
        `${lastDetail ? dim(` · ${lastDetail}`) : ""}`,
      "fail",
    );
    sendJson(res, lastStatus, lastBody);
  } finally {
    clearInterval(idleWatch);
  }
}

async function persistTier(tier) {
  try {
    saveState({ tier });
  } catch {}
}

const GO_PROBE_MODELS = ["longcat-2.5-preview-free", "beam-free", "minimax-m3.1-flash-free"];

/**
 * 用 Go 通道里的免费模型做一次 1 token 探测，判断密钥是否被上游接受。
 * 401/403 = 密钥无效；其它响应（404/429 等）说明鉴权已通过，只是探测条件受限。
 */
export async function probeGoKey(cfg, key) {
  let lastError = null;
  for (const model of GO_PROBE_MODELS) {
    try {
      const response = await fetch(`${cfg.goUpstream}/chat/completions`, {
        method: "POST",
        headers: {
          ...goHeaders(cfg, `probe_${sessionId()}`),
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `Go 密钥被拒绝（HTTP ${response.status}），请检查是否复制完整` };
      }
      try {
        await response.body?.cancel();
      } catch {}
      if (response.ok) return { ok: true };
      return { ok: true, note: `探测返回 HTTP ${response.status}，按有效凭据保存` };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, message: `无法连接 Go 上游：${lastError?.message ?? "网络错误"}` };
}

/**
 * 切换默认档位（免费 ↔ Go）。
 *
 * 档位影响：桥的默认档位展示、`/health`、以及（默认开启的）把 dsh 的
 * `agent-default-model` 改写成该档的默认模型——dsh 需要重启才会用新默认值；
 * 会话内即时切换仍走 dsh 的 `/model` 选择器。
 */
async function applyTier(cfg, state, next, options = {}) {
  const { persist = true, announce = true, writeDefault = cfg.autoDefault } = options;
  if (next !== "free" && next !== "go") return { ok: false, message: `unknown tier: ${next}` };
  if (next === "go" && !goEnabled(cfg)) {
    line(
      cfg,
      `${ICONS.warn} ${yellow("无法切到 Go 档")}：${dim("未配置 Go 凭据，用 --go-key 或 OPENCODE_GO_API_KEY 启动桥")}`,
    );
    return { ok: false, message: "go credential missing" };
  }
  if (state.tier === next) {
    if (announce) line(cfg, dim(`档位已经是 ${next === "go" ? "Go 订阅" : "免费"}`));
    return { ok: true, changed: false };
  }
  state.tier = next;
  updateDashboardMeta({ tier: next });
  if (persist) await persistTier(next);
  const target = DEFAULT_MODELS[next];
  if (announce) {
    line(cfg, `${ICONS.bolt} 默认档位 → ${bold(next === "go" ? "Go 订阅" : "免费")}`);
  }
  if (writeDefault) {
    const model =
      next === "go" && state.goIds?.length && !state.goIds.includes(target.model)
        ? state.goIds[0]
        : target.model;
    try {
      const changed = await setDefaultModel(cfg, next, model);
      if (changed.length > 0 && announce) {
        line(
          cfg,
          dim(
            `  已写入 dsh 默认模型 ${target.provider} / ${model}` +
              `${dim("（重启 DSH 后新会话生效；会话内切换用 /model）")}`,
          ),
        );
      } else if (changed.length === 0 && announce) {
        line(cfg, dim("  没找到带本桥标记的 dsh 配置，跳过默认模型改写（先运行 setup）"));
      }
    } catch (error) {
      line(cfg, `${ICONS.warn} ${yellow("写默认模型失败")}：${error.message}`);
    }
  }
  return { ok: true, changed: true };
}

export function startServer(cfg) {
  if (cfg.dataDir) configureDataDir(cfg.dataDir);
  // 密钥优先级：--go-key / OPENCODE_GO_API_KEY > TUI 里保存过的 data/secrets.json
  if (!cfg.goKey) cfg.goKey = savedGoKey();
  const persisted = loadState();
  const restoredTier = persisted.tier === "go" && goEnabled(cfg) ? "go" : "free";
  const plan = normalizePlan(cfg.goPlan ?? persisted.plan);
  const today = todayTotals();

  const dashboardOn = enableDashboard(
    cfg,
    {
      host: cfg.host,
      port: cfg.port,
      upstream: cfg.upstream,
      goUpstream: cfg.goUpstream,
      modelCount: null,
      goModelCount: null,
      goReady: goEnabled(cfg),
      goCredential: Boolean(cfg.goKey),
      tier: restoredTier,
      plan,
      pricingSource: PRICING_SOURCE,
      pricingAt: 0,
      pricingOk: null,
    },
    {
      initialStats: {
        requests: today.requests,
        ok: today.ok,
        fail: today.fail,
        cancel: today.cancel,
        input: today.input,
        output: today.output,
        cached: today.cached,
        saved: today.saved,
        goCost: today.goCost,
        unpriced: today.unpriced,
      },
      onTierToggle: () => {
        const next = state.tier === "go" ? "free" : "go";
        return applyTier(cfg, state, next);
      },
      onGoKeySubmit: (key) => submitGoKey(key),
      onPlanToggle: () => togglePlan(),
    },
  );

  const state = {
    session: sessionId(),
    tier: restoredTier,
    plan,
    models: null,
    modelsAt: 0,
    prevIds: null,
    ids: null,
    goModels: null,
    goAt: 0,
    prevGoIds: null,
    goIds: null,
    goCatalog: GO_CATALOG,
    pricing: createPricingState(),
    pricingWarned: false,
  };

  /** TUI 里按 Tab 切到 Go 但还没有密钥时，要求输入并验证后落盘。 */
  async function submitGoKey(rawKey) {
    const key = String(rawKey ?? "").trim();
    if (!key) return { ok: false, message: "密钥为空" };
    const check = await probeGoKey(cfg, key);
    if (!check.ok) return check;
    saveGoKey(key);
    cfg.goKey = key;
    state.goModels = null;
    state.goAt = 0;
    updateDashboardMeta({ goCredential: true, goReady: true });
    await getGoModels(cfg, state, true).catch(() => {});
    const switched = await applyTier(cfg, state, "go", { persist: true, announce: true });
    if (!switched.ok) return { ok: false, message: switched.message ?? "密钥已保存，但切换 Go 失败" };
    const message =
      `Go 密钥已保存${check.note ? `（${check.note}）` : ""}` +
      " · 默认档位已切到 Go，重启 DSH 后新会话生效";
    if (!dashboardOn) line(cfg, `${ICONS.ok} ${green(message)}`);
    return { ok: true, message };
  }

  /** 额度面板里切 Go / Go Plus，额度表按计划缩放并持久化。 */
  function togglePlan() {
    const resolved = state.plan === "go-plus" ? "go" : "go-plus";
    state.plan = resolved;
    try {
      saveState({ plan: resolved });
    } catch {}
    updateDashboardMeta({ plan: resolved });
    line(cfg, `${ICONS.sync} Go 计划 → ${resolved === "go-plus" ? "Go Plus（$40/月）" : "Go（$10/月）"}`);
    return resolved;
  }

  void pruneUsage().catch(() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const route = async () => {
      if (url.pathname === "/health") {
        const freeModels = await getFreeModels(cfg, state);
        const freeIds = freeModels.map((model) => model.id);
        const goModels = (await getGoModels(cfg, state)) ?? [];
        const goIds = goModels.map((model) => model.id);
        sendJson(res, 200, {
          ok: true,
          tier: state.tier,
          plan: state.plan,
          free: {
            upstream: cfg.upstream,
            modelsUrl: cfg.modelsUrl,
            count: freeIds.length,
            models: freeIds,
            priced: freeIds.filter((id) => priceFor(state.pricing, id)).length,
          },
          go: {
            upstream: cfg.goUpstream,
            enabled: goEnabled(cfg),
            credential: Boolean(cfg.goKey),
            count: goIds.length,
            models: goIds,
            priced: goIds.filter((id) => priceFor(state.pricing, id)).length,
          },
          // 兼容旧版 /health 字段
          upstream: cfg.upstream,
          modelsUrl: cfg.modelsUrl,
          count: freeIds.length,
          freeModels: freeIds,
          fallback: cfg.fallback,
          sync: cfg.sync,
          pricing: {
            source: PRICING_SOURCE,
            at: state.pricing.at,
            error: state.pricing.error,
          },
        });
        return;
      }
      if (url.pathname === "/tier") {
        if (req.method === "GET") {
          sendJson(res, 200, {
            tier: state.tier,
            plan: state.plan,
            goEnabled: goEnabled(cfg),
            goCredential: Boolean(cfg.goKey),
          });
          return;
        }
        if (req.method === "POST") {
          let next = null;
          try {
            const body = JSON.parse(await readBody(req));
            next = body?.tier ?? null;
          } catch {}
          const result = await applyTier(cfg, state, next);
          sendJson(res, result.ok ? 200 : 400, { ...result, tier: state.tier });
          return;
        }
      }
      if (url.pathname === "/usage" && req.method === "GET") {
        const daily = dailySummary(30);
        const usageMap = goUsageWindows();
        sendJson(res, 200, {
          ok: true,
          tier: state.tier,
          plan: state.plan,
          daily: daily.days,
          totals: daily.totals,
          allTime: allTimeTotals(),
          quota: quotaRows(state.plan, usageMap),
        });
        return;
      }
      if (url.pathname === "/v1/models" && req.method === "GET") {
        const models = await getFreeModels(cfg, state);
        sendJson(res, 200, { object: "list", data: models });
        return;
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        await handleChat(req, res, cfg, state, "free");
        return;
      }
      if (url.pathname === "/go/v1/models" && req.method === "GET") {
        const models = (await getGoModels(cfg, state)) ?? [];
        sendJson(res, 200, { object: "list", data: models });
        return;
      }
      if (url.pathname === "/go/v1/chat/completions" && req.method === "POST") {
        await handleChat(req, res, cfg, state, "go");
        return;
      }
      sendJson(res, 404, errorBody(`not found: ${req.method} ${url.pathname}`));
    };
    route().catch((error) => {
      if (isAbortError(error)) return;
      stopStatus();
      line(cfg, `${ICONS.fail} ${red("处理请求出错")}：${error.message}`);
      if (!res.headersSent) sendJson(res, 500, errorBody(error.message));
      else if (!res.writableEnded) res.end();
    });
  });

  server.on("error", (error) => {
    stopDashboard();
    console.error(`启动失败：${error.message}`);
    process.exit(1);
  });

  server.listen(cfg.port, cfg.host, () => {
    const goLine = cfg.goKey
      ? dim(cfg.goUpstream)
      : yellow("未配置密钥") + dim("（设置 OPENCODE_GO_API_KEY 或 --go-key 后重启）");
    if (dashboardOn) {
      line(
        cfg,
        `${ICONS.bridge} ${bold("桥接器已启动")} ` +
          `${dim(`· 档位 ${state.tier === "go" ? "Go 订阅" : "免费"} · Go 计划 ${state.plan === "go-plus" ? "Go Plus" : "Go"} · ` +
            `${cfg.allowPaid ? "允许付费模型" : "仅免费模型"} · ` +
            `${cfg.fallback ? "失败自动回退" : "失败不回退"} · ${cfg.sync ? `每 ${Math.round(cfg.syncMs / 1000)} 秒同步` : "不同步"}${goEnabled(cfg) ? "" : " · Go 未启用"}`)}`,
      );
      line(cfg, dim(`  免费通道 ${cfg.upstream}`));
      line(cfg, dim(`  Go 通道   ${cfg.goKey ? cfg.goUpstream : "未配置"}`));
      line(
        cfg,
        dim(`  账本 ${dataPaths().usage}`) +
          dim(` · Tab 切档 · d 每日账单 · q Go 额度 · s 总览 · ? 帮助 · k 设置 Go 密钥`),
      );
    } else {
      console.log("");
      console.log(`   ${ICONS.bridge} ${bold("OpenCode → DeepSeek Harness 桥接器已启动")}`);
      console.log(`   ${gray("监听地址")}    ${cyan(`http://${cfg.host}:${cfg.port}`)}`);
      console.log(`   ${gray("免费通道")}  ${dim(cfg.upstream)}`);
      console.log(`   ${gray("Go 通道")}   ${goLine}`);
      console.log(
        `   ${gray("默认档位")}  ${state.tier === "go" ? "Go 订阅" : "免费"}` +
          ` ${dim(`· Go 计划 ${state.plan === "go-plus" ? "Go Plus（$40/月）" : "Go（$10/月）"}`)}`,
      );
      console.log(`   ${gray("用量账本")}  ${dim(dataPaths().usage)}`);
      console.log(`   ${gray("自动同步")}  ${cfg.sync ? `开（每 ${Math.round(cfg.syncMs / 1000)} 秒检查模型列表变化）` : "关"}`);
      console.log(
        `   ${gray("策略")}      ${cfg.allowPaid ? red("允许付费模型") : green("仅免费模型")} · ` +
          `${cfg.fallback ? "失败自动回退" : "失败不回退"}`,
      );
      console.log("");
    }
    // 先加载 Go 目录再加载免费列表：两次同步写配置，顺序固定才不会互相覆盖。
    const warm = async () => {
      await getGoModels(cfg, state, true).catch((error) => {
        line(cfg, `${ICONS.warn} ${yellow("初始化 Go 模型目录失败")}：${error.message}`);
      });
      await getFreeModels(cfg, state, true).catch((error) => {
        line(cfg, `${ICONS.warn} ${yellow("初始化免费模型列表失败")}：${error.message}`);
      });
    };
    void warm();
  });

  if (cfg.sync && cfg.syncMs > 0) {
    const timer = setInterval(() => {
      void (async () => {
        await getGoModels(cfg, state, true).catch(() => {});
        await getFreeModels(cfg, state, true).catch(() => {});
      })();
    }, cfg.syncMs);
    timer.unref?.();
  }

  const pricingTimer = setInterval(() => {
    if (!state.ids) return;
    ensurePricing(cfg, state).catch(() => {});
  }, 5 * 60 * 1000);
  pricingTimer.unref?.();

  return server;
}
