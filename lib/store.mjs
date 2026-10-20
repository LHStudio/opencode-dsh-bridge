import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录（lib/ 的上一级）。数据目录与代码目录解耦，便于打包和迁移。 */
export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const DEFAULT_DATA_DIR = path.join(ROOT, "data");
let dataDir = process.env.BRIDGE_DATA_DIR?.trim()
  ? path.resolve(process.env.BRIDGE_DATA_DIR.trim())
  : DEFAULT_DATA_DIR;

/** 允许在启动前改数据目录（CLI 的 --data-dir）。 */
export function configureDataDir(dir) {
  if (typeof dir === "string" && dir.trim()) {
    dataDir = path.resolve(dir.trim());
    usageCache = null;
  }
  return dataDir;
}

export function dataDirectory() {
  return dataDir;
}

export function dataPaths() {
  return {
    dir: dataDir,
    state: path.join(dataDir, "state.json"),
    secrets: path.join(dataDir, "secrets.json"),
    usage: path.join(dataDir, "usage.jsonl"),
  };
}

const PLAN_IDS = ["go", "go-plus"];
const DEFAULT_STATE = {
  tier: "free",
  plan: "go",
  createdAt: null,
};
const DEFAULT_SECRETS = { goKey: "" };

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode = 0o644) {
  ensureDataDir();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    try {
      fs.chmodSync(tmp, mode);
    } catch {}
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 状态（档位 / Go 计划）                                              */
/* ------------------------------------------------------------------ */

export function loadState() {
  const paths = dataPaths();
  const state = { ...DEFAULT_STATE, ...readJson(paths.state, {}) };
  // 旧版本把状态写在项目根目录的 .bridge-state.json，自动迁移后删除。
  try {
    const legacy = path.join(ROOT, ".bridge-state.json");
    if (fs.existsSync(legacy)) {
      const json = readJson(legacy, {});
      if (json?.tier === "free" || json?.tier === "go") state.tier = json.tier;
      fs.rmSync(legacy, { force: true });
    }
  } catch {}
  if (state.tier !== "free" && state.tier !== "go") state.tier = "free";
  if (!PLAN_IDS.includes(state.plan)) state.plan = "go";
  state.createdAt ??= Date.now();
  return state;
}

export function saveState(patch = {}) {
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  writeJson(dataPaths().state, next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Go 密钥（单独文件、权限 600，不写入 state）                         */
/* ------------------------------------------------------------------ */

export function loadSecrets() {
  return { ...DEFAULT_SECRETS, ...readJson(dataPaths().secrets, {}) };
}

export function savedGoKey() {
  const key = loadSecrets().goKey;
  return typeof key === "string" ? key.trim() : "";
}

export function saveGoKey(key) {
  const value = String(key ?? "").trim();
  writeJson(dataPaths().secrets, { ...loadSecrets(), goKey: value, savedAt: new Date().toISOString() }, 0o600);
  return value;
}

export function clearGoKey() {
  writeJson(dataPaths().secrets, { ...loadSecrets(), goKey: "", savedAt: new Date().toISOString() }, 0o600);
}

/* ------------------------------------------------------------------ */
/* 用量账本（append-only JSONL，按请求一条）                           */
/* ------------------------------------------------------------------ */

let usageCache = null;
let appendQueue = Promise.resolve();

function validRecord(rec) {
  return (
    rec &&
    Number.isFinite(rec.ts) &&
    typeof rec.model === "string" &&
    (rec.tier === "free" || rec.tier === "go")
  );
}

export function loadUsage() {
  if (usageCache) return usageCache;
  usageCache = [];
  try {
    const text = fs.readFileSync(dataPaths().usage, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try {
        const rec = JSON.parse(raw);
        if (validRecord(rec)) usageCache.push(rec);
      } catch {}
    }
  } catch {}
  return usageCache;
}

export function appendUsage(record) {
  const rec = { ts: Date.now(), ...record };
  if (!validRecord(rec)) return appendQueue;
  loadUsage().push(rec);
  ensureDataDir();
  const line = `${JSON.stringify(rec)}\n`;
  appendQueue = appendQueue
    .then(() => fsp.appendFile(dataPaths().usage, line))
    .catch(() => {});
  return appendQueue;
}

/** 丢掉超过 maxAgeDays 的旧记录（默认 400 天），返回删掉的条数。 */
export async function pruneUsage(maxAgeDays = 400) {
  const usage = loadUsage();
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  const kept = usage.filter((rec) => rec.ts >= cutoff);
  const dropped = usage.length - kept.length;
  if (dropped === 0) return 0;
  await appendQueue.catch(() => {});
  ensureDataDir();
  const tmp = `${dataPaths().usage}.tmp-${process.pid}`;
  const body = kept.map((rec) => JSON.stringify(rec)).join("\n");
  await fsp.writeFile(tmp, body ? `${body}\n` : "", "utf8");
  await fsp.rename(tmp, dataPaths().usage);
  usageCache = kept;
  return dropped;
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth(ts) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function emptyDay(key) {
  return {
    date: key,
    requests: 0,
    ok: 0,
    fail: 0,
    cancel: 0,
    input: 0,
    output: 0,
    cached: 0,
    saved: 0,
    goCost: 0,
    unpriced: 0,
  };
}

function addToDay(row, rec) {
  row.requests += 1;
  if (rec.outcome === "ok") row.ok += 1;
  else if (rec.outcome === "cancel") row.cancel += 1;
  else if (rec.outcome) row.fail += 1;
  row.input += Number(rec.prompt) || 0;
  row.output += Number(rec.completion) || 0;
  row.cached += Number(rec.cached) || 0;
  if (rec.priced === false) row.unpriced += 1;
  const cost = Number(rec.cost) || 0;
  if (rec.tier === "go") row.goCost += cost;
  else row.saved += cost;
}

/**
 * 最近 N 天（含今天）的每日汇总，按本地时区切日，缺数据的日期补 0。
 */
export function dailySummary(days = 14, now = Date.now()) {
  const span = Math.max(1, Math.min(120, Math.floor(Number(days) || 14)));
  const map = new Map();
  for (const rec of loadUsage()) {
    if (!Number.isFinite(rec.ts)) continue;
    const key = dateKey(rec.ts);
    let row = map.get(key);
    if (!row) {
      row = emptyDay(key);
      map.set(key, row);
    }
    addToDay(row, rec);
  }
  const list = [];
  const todayStart = startOfDay(now);
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - i);
    const key = dateKey(d.getTime());
    list.push(map.get(key) ?? emptyDay(key));
  }
  const totals = emptyDay("合计");
  for (const row of list) {
    for (const field of ["requests", "ok", "fail", "cancel", "input", "output", "cached", "saved", "goCost", "unpriced"]) {
      totals[field] += row[field];
    }
  }
  return { days: list, totals };
}

export function allTimeTotals() {
  const totals = emptyDay("all");
  for (const rec of loadUsage()) addToDay(totals, rec);
  return totals;
}

export function todayTotals(now = Date.now()) {
  return dailySummary(1, now).days[0];
}

/**
 * Go 通道按模型聚合 5 小时 / 近 7 天 / 本月 的折算花费，供额度面板使用。
 * 金额按官方 Go 价格计算（见 ./goQuota.mjs），窗口与官方 20% / 50% / 100% 对应。
 */
export function goUsageWindows(now = Date.now()) {
  const since = {
    h5: now - 5 * 3600_000,
    week: now - 7 * 86400_000,
    month: startOfMonth(now),
  };
  const map = new Map();
  for (const rec of loadUsage()) {
    if (rec.tier !== "go") continue;
    const cost = Number(rec.cost);
    if (!Number.isFinite(cost)) continue;
    let row = map.get(rec.model);
    if (!row) {
      row = { h5: 0, week: 0, month: 0, requests: 0, tokens: 0 };
      map.set(rec.model, row);
    }
    if (rec.ts >= since.h5) row.h5 += cost;
    if (rec.ts >= since.week) row.week += cost;
    if (rec.ts >= since.month) {
      row.month += cost;
      row.requests += 1;
      row.tokens += (Number(rec.prompt) || 0) + (Number(rec.completion) || 0);
    }
  }
  return map;
}
