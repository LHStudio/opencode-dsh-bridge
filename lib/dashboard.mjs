import {
  ICONS,
  bold,
  clockTime,
  cyan,
  dim,
  formatCount,
  formatDuration,
  formatMoney,
  green,
  red,
  truncateAnsi,
  yellow,
} from "./ansi.mjs";
import { buildDailyLines, buildHelpLines, buildOverviewLines, buildQuotaLines } from "./panels.mjs";
import { PLAN_IDS } from "./goQuota.mjs";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LOGS = 5000;
const RENDER_INTERVAL_MS = 120;
const PANEL_KEYS = { d: "daily", q: "quota", "?": "help", h: "help" };

function defaultStats() {
  return {
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

function maskKey(value) {
  const text = String(value);
  if (!text) return "";
  if (text.length <= 8) return "•".repeat(text.length);
  return `${"•".repeat(Math.min(20, text.length - 4))}${text.slice(-4)}`;
}

export function createDashboard(cfg, initialMeta = {}, options = {}) {
  const out = process.stdout;
  const input = process.stdin;
  const startedAt = Date.now();
  const stats = { ...defaultStats(), ...(options.initialStats ?? {}) };
  const logs = [];
  const active = new Map();
  const onTierToggle = options.onTierToggle;
  const onGoKeySubmit = options.onGoKeySubmit;
  const onPlanToggle = options.onPlanToggle;
  let meta = {
    host: cfg.host,
    port: cfg.port,
    upstream: cfg.upstream,
    modelCount: null,
    goModelCount: null,
    goReady: false,
    goCredential: false,
    tier: "free",
    plan: cfg.goPlan ?? "go",
    pricingSource: "models.dev",
    pricingAt: 0,
    pricingOk: null,
    ...initialMeta,
  };
  let width = out.columns || 80;
  let height = out.rows || 24;
  let offset = 0;
  let view = "logs";
  let panelOffset = 0;
  let keyPrompt = null;
  let frame = 0;
  let lastRender = 0;
  let timer = null;
  let inputBuffer = "";
  let closed = false;
  let clearNext = true;

  const headerHeight = () => {
    const lines = headerLines();
    return Math.min(lines.length, Math.max(1, height - 2));
  };

  const logRows = () => Math.max(0, height - headerHeight() - 1);

  const maxOffset = () => Math.max(0, logs.length - logRows());

  const headerLines = () => {
    const uptime = formatDuration((Date.now() - startedAt) / 1000);
    const origin = `${meta.host}:${meta.port}`;
    const freePart =
      meta.modelCount === null ? "" : ` ${dim("·")} ${ICONS.bolt} ${bold(String(meta.modelCount))} ${dim("免费")}`;
    const goPart =
      meta.goReady && meta.goModelCount
        ? ` ${dim("+")} ${bold(String(meta.goModelCount))} ${dim("Go")}`
        : meta.goReady
          ? ` ${dim("+ Go")}`
          : "";
    const tierBadge =
      meta.tier === "go"
        ? cyan(`档位 Go · ${meta.plan === "go-plus" ? "Go Plus" : "Go"}`) + (meta.goReady ? "" : yellow("（未启用）"))
        : green("档位 免费");
    const line1 =
      `${ICONS.bridge} ${bold("OpenCode 桥接器")} ` +
      `${dim(`· ${origin} · 运行 ${uptime}`)}${freePart}${goPart} ${dim("·")} ${tierBadge}`;

    const counters =
      `${dim("今日请求")} ${bold(String(stats.requests))}  ` +
      `${green(`${ICONS.ok} ${stats.ok}`)}  ` +
      `${stats.fail ? red(`${ICONS.fail} ${stats.fail}`) : dim(`${ICONS.fail} ${stats.fail}`)}  ` +
      `${stats.cancel ? yellow(`${ICONS.cancel} ${stats.cancel}`) : dim(`${ICONS.cancel} ${stats.cancel}`)}`;
    const tokens =
      `${dim("输入")} ${bold(formatCount(stats.input))}` +
      `${stats.cached ? dim(`（缓存 ${formatCount(stats.cached)}）`) : ""} ` +
      `${dim("· 输出")} ${bold(formatCount(stats.output))} ${dim("tokens")}`;
    const line2 = `${counters} ${dim("·")} ${tokens}`;

    const pricing =
      meta.pricingOk === false
        ? `${red("计价更新失败")}${meta.pricingAt ? dim(`（沿用 ${clockTime(meta.pricingAt)}）`) : ""}`
        : `${dim(meta.pricingSource)}${meta.pricingAt ? dim(` · ${clockTime(meta.pricingAt)} 更新`) : dim(" · 更新中…")}`;
    const goCost =
      meta.goReady && (stats.goCost > 0 || meta.tier === "go")
        ? ` ${dim("· Go ≈")} ${bold(cyan(formatMoney(stats.goCost)))}`
        : "";
    const line3 =
      `${dim("今日白嫖 ≈")} ${bold(green(formatMoney(stats.saved)))}` +
      `${stats.unpriced ? dim(`（${stats.unpriced} 次未计价）`) : ""}` +
      `${goCost} ${dim("·")} ${pricing} ${dim("· 上游")} ${dim(shortHost(meta.upstream))}`;

    return [line1, line2, line3, dim("─".repeat(Math.max(10, width)))];
  };

  const viewHint = () => {
    if (view === "daily") return bold(cyan("每日账单"));
    if (view === "quota") return bold(cyan("Go 额度"));
    if (view === "overview") return bold(cyan("总览"));
    if (view === "help") return bold(cyan("帮助"));
    return "";
  };

  const footerLine = () => {
    if (keyPrompt) {
      const spinner = cyan(SPINNER[frame % SPINNER.length]);
      if (keyPrompt.busy) return `${spinner} 正在验证 Go 密钥… ${dim(`（${maskKey(keyPrompt.value)}）`)}`;
      const error = keyPrompt.error ? ` ${red(keyPrompt.error)}` : "";
      return (
        `${yellow("Go 密钥")} ${bold(maskKey(keyPrompt.value) || "…")}` +
        `${dim(" 回车保存 · Esc 取消 · 直接粘贴")}${error}`
      );
    }
    const scroll = offset > 0 ? dim(` · 已上翻 ${offset} 行，滚轮向下回到底部`) : "";
    const entries = [...active.values()];
    if (entries.length > 0 && view === "logs") {
      const entry = entries[entries.length - 1];
      const spinner = cyan(SPINNER[frame % SPINNER.length]);
      const more = entries.length > 1 ? dim(` · +${entries.length - 1} 个进行中`) : "";
      return `${spinner} ${entry.getText()}${more}${scroll}`;
    }
    if (view !== "logs") {
      const lines = panelCache.lines;
      const rows = logRows();
      const start = panelOffset + 1;
      const end = Math.min(lines.length, panelOffset + rows);
      return dim(
        `${viewHint()} ${dim("·")} d 账单 · q 额度 · s 总览 · ? 帮助 · Esc 返回日志 · ` +
          `↑/↓ PgUp/PgDn 滚动${lines.length > rows ? `（${start}-${end}/${lines.length}）` : ""} · Ctrl+C 退出`,
      );
    }
    const tabHint =
      typeof onTierToggle === "function"
        ? ` · ${meta.goCredential ? "Tab 切档" : "Tab 切档（Go 会提示输入密钥）"}`
        : "";
    return dim(
      `滚轮 / PgUp / PgDn 查看历史${offset ? `（已上翻 ${offset} 行）` : ""}${tabHint} · ` +
        `d 账单 · q 额度 · s 总览 · ? 帮助 · Ctrl+C 退出`,
    );
  };

  const visibleLogs = () => {
    if (logs.length === 0) return [];
    const rows = logRows();
    if (rows <= 0) return [];
    if (offset === 0) return logs.slice(-rows);
    const end = Math.max(0, logs.length - offset);
    const start = Math.max(0, end - rows);
    return logs.slice(start, end);
  };

  const panelCache = { lines: [], at: 0 };

  const panelLines = () => {
    const now = Date.now();
    if (view === "logs") return [];
    if (panelCache.at && now - panelCache.at < 1000 && panelCache.view === view && panelCache.plan === meta.plan) {
      return panelCache.lines;
    }
    let lines = [];
    if (view === "daily") lines = buildDailyLines(now, 14);
    else if (view === "quota") lines = buildQuotaLines(meta.plan, now);
    else if (view === "overview") lines = buildOverviewLines(meta, now);
    else if (view === "help") lines = buildHelpLines();
    panelCache.lines = lines;
    panelCache.at = now;
    panelCache.view = view;
    panelCache.plan = meta.plan;
    return lines;
  };

  const maxPanelOffset = () => Math.max(0, panelCache.lines.length - logRows());

  const panelScrollBy = (delta) => {
    panelOffset = Math.min(maxPanelOffset(), Math.max(0, panelOffset + delta));
    render(true);
  };

  const render = (force = false) => {
    if (closed) return;
    const now = Date.now();
    if (!force && now - lastRender < 100) return;
    lastRender = now;
    frame += 1;

    width = out.columns || width;
    height = out.rows || height;
    if (offset > maxOffset()) offset = maxOffset();

    let header = headerLines();
    const maxHeader = Math.max(1, height - 2);
    if (header.length > maxHeader) header = header.slice(0, maxHeader);
    const rows = logRows();

    let body;
    if (view === "logs") {
      body = visibleLogs().slice(-rows);
    } else {
      panelLines();
      if (panelOffset > maxPanelOffset()) panelOffset = maxPanelOffset();
      body = panelCache.lines.slice(panelOffset, panelOffset + Math.max(0, rows));
    }

    const lines = [];
    lines.push(...header);
    for (const log of body) lines.push(log);
    const target = Math.max(0, height - 1);
    while (lines.length < target) lines.push("");
    lines.push(footerLine());

    let output = clearNext ? "\x1b[2J\x1b[H" : "\x1b[H";
    clearNext = false;
    for (let i = 0; i < height; i += 1) {
      output += truncateAnsi(lines[i] ?? "", width) + "\x1b[K";
      if (i < height - 1) output += "\r\n";
    }
    out.write(output);
  };

  const addLog = (text) => {
    const value = String(text);
    for (const part of value.split("\n")) {
      logs.push(part.replace(/\r/g, ""));
      if (offset > 0) offset += 1;
    }
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
    if (offset > maxOffset()) offset = maxOffset();
    render();
  };

  const scrollBy = (delta) => {
    if (view === "logs") {
      offset = Math.min(maxOffset(), Math.max(0, offset + delta));
    } else {
      panelOffset = Math.min(maxPanelOffset(), Math.max(0, panelOffset + delta));
    }
    render(true);
  };

  const setView = (next) => {
    if (!next || next === view) return;
    view = next;
    panelOffset = 0;
    render(true);
  };

  const clearLogs = () => {
    logs.length = 0;
    offset = 0;
    render(true);
  };

  const toggleTier = () => {
    if (typeof onTierToggle !== "function") return;
    if (meta.tier === "free" && !meta.goCredential && typeof onGoKeySubmit === "function") {
      keyPrompt = { value: "", busy: false, error: "" };
      render(true);
      return;
    }
    Promise.resolve()
      .then(() => onTierToggle())
      .catch(() => {});
  };

  const submitKeyPrompt = () => {
    const value = keyPrompt.value.trim();
    if (!value) {
      keyPrompt.error = "密钥不能为空";
      render(true);
      return;
    }
    keyPrompt.busy = true;
    keyPrompt.error = "";
    render(true);
    Promise.resolve()
      .then(() => onGoKeySubmit(value))
      .then((result) => {
        if (result?.ok) {
          meta = { ...meta, goCredential: true, goReady: true };
          keyPrompt = null;
          addLog(result.message ?? "Go 密钥已保存");
        } else {
          keyPrompt = { value, busy: false, error: result?.message ?? "验证失败" };
          render(true);
        }
      })
      .catch((error) => {
        keyPrompt = { value, busy: false, error: error?.message ?? "保存失败" };
        render(true);
      });
  };

  const cancelKeyPrompt = () => {
    keyPrompt = null;
    render(true);
  };

  const handlePromptInput = (chunk) => {
    let changed = false;
    for (const ch of chunk) {
      if (ch === "\x03") {
        exit(130);
        return;
      }
      if (keyPrompt.busy) continue;
      if (ch === "\x1b") {
        cancelKeyPrompt();
        return;
      }
      if (ch === "\r" || ch === "\n") {
        submitKeyPrompt();
        return;
      }
      if (ch === "\x7f" || ch === "\x08") {
        keyPrompt.value = keyPrompt.value.slice(0, -1);
        keyPrompt.error = "";
        changed = true;
        continue;
      }
      if (ch === "\t") continue;
      if (ch >= " " && ch !== "\x7f") {
        keyPrompt.value += ch;
        keyPrompt.error = "";
        changed = true;
      }
    }
    if (changed) render(true);
  };

  const togglePlan = () => {
    if (typeof onPlanToggle !== "function") return;
    Promise.resolve()
      .then(() => onPlanToggle())
      .catch(() => {})
      .then((next) => {
        if (typeof next === "string" && PLAN_IDS.includes(next)) {
          meta = { ...meta, plan: next };
          panelCache.at = 0;
          addLog(`Go 计划 → ${next === "go-plus" ? "Go Plus（$40/月）" : "Go（$10/月）"}`);
        }
      });
  };

  const handleSequence = (sequence) => {
    if (sequence === "\x1b[5~") scrollBy(view === "logs" ? logRows() : -logRows());
    else if (sequence === "\x1b[6~") scrollBy(view === "logs" ? -logRows() : logRows());
    else if (sequence === "\x1b[A") scrollBy(view === "logs" ? 1 : -1);
    else if (sequence === "\x1b[B") scrollBy(view === "logs" ? -1 : 1);
    else if (sequence === "\x1b[F") scrollBy(view === "logs" ? -maxOffset() : maxPanelOffset());
    else if (sequence === "\x1b[H") scrollBy(view === "logs" ? maxOffset() : -maxPanelOffset());
    else if (sequence.startsWith("\x1b[<")) {
      const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(sequence);
      if (!match) return;
      const button = Number(match[1]);
      const base = button & ~(4 | 8 | 16 | 32);
      if (base === 64) scrollBy(view === "logs" ? 3 : -3);
      else if (base === 65) scrollBy(view === "logs" ? -3 : 3);
    }
  };

  const onInput = (chunk) => {
    if (keyPrompt) {
      handlePromptInput(chunk);
      return;
    }
    inputBuffer += chunk;
    const buffer = inputBuffer;
    let index = 0;
    while (index < buffer.length) {
      const ch = buffer[index];
      if (ch === "\x03") {
        exit(130);
        return;
      }
      if (ch === "\t") {
        toggleTier();
        index += 1;
        continue;
      }
      if (ch !== "\x1b") {
        const key = ch.toLowerCase();
        if (key === "d") setView("daily");
        else if (key === "q") setView("quota");
        else if (key === "s") setView("overview");
        else if (key === "?" || key === "h") setView("help");
        else if (key === "p" && view === "quota") togglePlan();
        else if (key === "k") {
          keyPrompt = { value: "", busy: false, error: "" };
          render(true);
        } else if (key === "c") clearLogs();
        index += 1;
        continue;
      }
      if (index === buffer.length - 1) {
        if (view !== "logs") setView("logs");
        else if (view === "logs" && offset > 0) {
          offset = 0;
          render(true);
        }
        index += 1;
        continue;
      }
      if (buffer.startsWith("\x1b[M", index)) {
        if (index + 6 > buffer.length) break;
        const button = buffer.charCodeAt(index + 3) - 32;
        const base = button & ~(4 | 8 | 16 | 32);
        if (base === 64) scrollBy(view === "logs" ? 3 : -3);
        else if (base === 65) scrollBy(view === "logs" ? -3 : 3);
        index += 6;
        continue;
      }
      if (buffer[index + 1] !== "[") {
        if (index + 2 > buffer.length) break;
        index += 2;
        continue;
      }
      let end = index + 2;
      while (end < buffer.length && !/[@-~]/.test(buffer[end])) end += 1;
      if (end >= buffer.length) break;
      handleSequence(buffer.slice(index, end + 1));
      index = end + 1;
    }
    inputBuffer = buffer.slice(index);
    if (!inputBuffer.startsWith("\x1b")) inputBuffer = "";
    if (inputBuffer.length > 64) inputBuffer = inputBuffer.slice(-64);
  };

  const onResize = () => {
    width = out.columns || width;
    height = out.rows || height;
    clearNext = true;
    render(true);
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    try {
      out.write("\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?7h\x1b[?1049l");
    } catch {}
    try {
      if (input.isTTY) input.setRawMode(false);
    } catch {}
    try {
      input.pause();
    } catch {}
    input.off?.("data", onInput);
    out.off?.("resize", onResize);
  };

  const onSignal = () => {
    cleanup();
    process.exit(130);
  };

  const exit = (code) => {
    cleanup();
    process.exit(code);
  };

  const start = () => {
    process.on("exit", cleanup);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H");
    if (input.isTTY) {
      try {
        input.setRawMode(true);
      } catch {}
      try {
        input.setEncoding("utf8");
      } catch {}
      try {
        input.resume();
      } catch {}
      input.on("data", onInput);
    }
    out.on("resize", onResize);
    timer = setInterval(() => render(true), RENDER_INTERVAL_MS);
    timer.unref?.();
    render(true);
  };

  try {
    start();
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    addLog,
    setMeta(next) {
      meta = { ...meta, ...next };
      render(true);
    },
    recordRequest(info) {
      stats.requests += 1;
      if (info.outcome === "ok") stats.ok += 1;
      else if (info.outcome === "cancel") stats.cancel += 1;
      else stats.fail += 1;
      const usage = info.usage;
      if (usage) {
        const prompt = Number(usage.prompt_tokens);
        const completion = Number(usage.completion_tokens);
        const cached = Number(usage.prompt_tokens_details?.cached_tokens);
        if (Number.isFinite(prompt)) stats.input += prompt;
        if (Number.isFinite(completion)) stats.output += completion;
        if (Number.isFinite(cached)) stats.cached += cached;
        if (info.priced && Number.isFinite(info.costUsd)) {
          if (info.tier === "go") stats.goCost += info.costUsd;
          else stats.saved += info.costUsd;
        } else {
          stats.unpriced += 1;
        }
      }
      render(true);
    },
    createStatus() {
      const token = Symbol("active");
      active.set(token, { getText: () => "" });
      return {
        update(text) {
          const entry = active.get(token);
          if (!entry) return;
          entry.getText = typeof text === "function" ? text : () => String(text);
        },
        finish() {
          active.delete(token);
          render(true);
        },
      };
    },
    clearActive() {
      active.clear();
      render(true);
    },
    stop() {
      cleanup();
    },
  };
}

function shortHost(upstream) {
  try {
    return new URL(upstream).host;
  } catch {
    return upstream;
  }
}
