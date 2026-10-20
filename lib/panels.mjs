import { ICONS, bold, cyan, dim, formatCount, formatMoney, green, red, visibleWidth, yellow } from "./ansi.mjs";
import { allTimeTotals, dailySummary, dataPaths, goUsageWindows, todayTotals } from "./store.mjs";
import { PLAN_IDS, planInfo, quotaRows, quotaSummary } from "./goQuota.mjs";
import { VERSION } from "./version.mjs";

function padTo(text, width) {
  const current = visibleWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

function padStartTo(text, width) {
  const current = visibleWidth(text);
  if (current >= width) return text;
  return " ".repeat(width - current) + text;
}

/** 面板里的金额：小额保留更多小数，避免全显示成 $0。 */
export function formatCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1000) return `$${Math.round(n)}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(5)}`;
  if (n >= 0.000001) return `$${n.toFixed(6)}`;
  return "<$0.000001";
}

function bar(pct, cells = 5) {
  if (pct === null || !Number.isFinite(pct)) return dim("─".repeat(cells));
  const ratio = Math.max(0, Math.min(1, pct));
  const filled = Math.round(ratio * cells);
  const raw = "█".repeat(filled) + "░".repeat(cells - filled);
  if (pct >= 0.95) return red(raw);
  if (pct >= 0.8) return yellow(raw);
  return green(raw);
}

function pctText(pct) {
  if (pct === null || !Number.isFinite(pct)) return "    -";
  return padStartTo(`${Math.round(pct * 1000) / 10}%`, 5);
}

const DAILY_COLUMNS = { date: 12, requests: 6, ok: 6, fail: 6, cancel: 6, input: 9, output: 9, saved: 12, goCost: 12 };

function dailyRow(row, label) {
  return (
    `${padTo(label, DAILY_COLUMNS.date)}` +
    `${padStartTo(String(row.requests), DAILY_COLUMNS.requests)}` +
    `${padStartTo(String(row.ok), DAILY_COLUMNS.ok)}` +
    `${padStartTo(String(row.fail), DAILY_COLUMNS.fail)}` +
    `${padStartTo(String(row.cancel), DAILY_COLUMNS.cancel)}` +
    `${padStartTo(formatCount(row.input), DAILY_COLUMNS.input)}` +
    `${padStartTo(formatCount(row.output), DAILY_COLUMNS.output)}` +
    `${padStartTo(green(formatCost(row.saved)), DAILY_COLUMNS.saved)}` +
    `${padStartTo(cyan(formatCost(row.goCost)), DAILY_COLUMNS.goCost)}`
  );
}

/** 每日账单面板：请求次数 / token / 白嫖等效价值 / Go 折算花费。 */
export function buildDailyLines(now = Date.now(), days = 14) {
  const summary = dailySummary(days, now);
  const rows = summary.days;
  const totals = summary.totals;
  const today = rows.at(-1);
  const todayKey = today?.date;
  const width = Math.min(
    96,
    Math.max(
      60,
      DAILY_COLUMNS.date +
        DAILY_COLUMNS.requests +
        DAILY_COLUMNS.ok +
        DAILY_COLUMNS.fail +
        DAILY_COLUMNS.cancel +
        DAILY_COLUMNS.input +
        DAILY_COLUMNS.output +
        DAILY_COLUMNS.saved +
        DAILY_COLUMNS.goCost,
    ),
  );
  const lines = [
    `${bold(cyan("每日账单"))} ${dim(`本地时区 · 最近 ${rows.length} 天 · 每次请求一行，持久化在 data/usage.jsonl`)}`,
    "",
    dim(
      padTo("日期", DAILY_COLUMNS.date) +
        padStartTo("请求", DAILY_COLUMNS.requests) +
        padStartTo("成功", DAILY_COLUMNS.ok) +
        padStartTo("失败", DAILY_COLUMNS.fail) +
        padStartTo("中断", DAILY_COLUMNS.cancel) +
        padStartTo("输入", DAILY_COLUMNS.input) +
        padStartTo("输出", DAILY_COLUMNS.output) +
        padStartTo("白嫖", DAILY_COLUMNS.saved) +
        padStartTo("Go 花费", DAILY_COLUMNS.goCost),
    ),
  ];
  for (const row of rows) {
    const isToday = row.date === todayKey;
    const label = isToday ? green(`${row.date.slice(5)} 今天`) : dim(row.date.slice(5));
    lines.push(dailyRow(row, label));
  }
  lines.push(dim("─".repeat(width)));
  lines.push(bold(dailyRow(totals, "合计")));
  lines.push(bold(dailyRow(today ?? totals, "今日")));
  lines.push("");
  lines.push(dim("白嫖 = 免费通道按 Zen 官方价折算的等效价值，不产生账单。"));
  lines.push(dim("Go 花费 = Go 通道按 Go 官方额度价折算，会计入你的 Go / Go Plus 额度（估算，非账单）。"));
  lines.push(dim(`账本文件：${dataPaths().usage}`));
  return lines;
}

/** 总览面板：当日 / 累计 / Go 计划 / 数据文件位置一屏看完。 */
export function buildOverviewLines(meta = {}, now = Date.now()) {
  const today = todayTotals(now);
  const all = allTimeTotals();
  const paths = dataPaths();
  const planId = PLAN_IDS.includes(meta.plan) ? meta.plan : "go";
  const planBar = PLAN_IDS.map((id) => {
    const info = planInfo(id);
    const label = `${info.name}（$${info.priceMonthly}/月）`;
    return id === planId ? bold(cyan(label)) : dim(label);
  }).join(dim(" / "));
  const tierText = meta.tier === "go" ? `Go 订阅 · ${planInfo(planId).name}` : "免费（Zen）";
  const goText = meta.goCredential
    ? meta.goReady
      ? green("已启用")
      : yellow("密钥已保存 · 等待模型同步")
    : dim("未配置密钥（Tab 切到 Go 时输入，或按 k）");
  const meter = (row) =>
    `${bold(String(row.requests))} 次` +
    ` · ${green(`${ICONS.ok} ${row.ok}`)} ${red(`${ICONS.fail} ${row.fail}`)}` +
    ` ${yellow(`${ICONS.cancel} ${row.cancel}`)}` +
    ` · 输入 ${formatCount(row.input)} · 输出 ${formatCount(row.output)} tokens`;
  const lines = [
    `${bold(cyan("总览"))} ${dim(`opencode-dsh-bridge v${VERSION}`)} ${dim("·")} 档位 ${bold(tierText)}`,
    "",
    `${dim("今日")}  ${meter(today)}`,
    `${dim("      ")}  白嫖 ≈ ${bold(green(formatCost(today.saved)))}` +
      ` · Go ≈ ${bold(cyan(formatCost(today.goCost)))}` +
      `${today.unpriced ? dim(` · ${today.unpriced} 次未计价`) : ""}`,
    `${dim("累计")}  ${meter(all)}`,
    `${dim("      ")}  白嫖 ≈ ${bold(green(formatCost(all.saved)))} · Go ≈ ${bold(cyan(formatCost(all.goCost)))}`,
    "",
    `${dim("Go")}    计划 ${planBar} ${dim("· p 切换")} · 通道 ${goText}`,
    `${dim("上游")}  免费 ${dim(meta.upstream ?? "-")}`,
    `${dim("      ")}  Go   ${dim(meta.goUpstream ?? "-")}`,
    `${dim("数据")}  ${dim(paths.dir)}`,
    `${dim("      ")}  state.json · secrets.json（权限 600）· usage.jsonl`,
    "",
    dim("白嫖 = 免费通道按 Zen 官方价折算的等效价值；Go 花费按 Go 官方额度价折算。"),
    dim("账本每次请求追加一行，重启不丢；data/ 不要提交到 Git。"),
  ];
  return lines;
}

/** Go 额度面板：每个模型的 5h / 周 / 月窗口进度与剩余额度。 */
export function buildQuotaLines(planId, now = Date.now()) {
  const usage = goUsageWindows(now);
  const rows = quotaRows(planId, usage, now);
  const summary = quotaSummary(planId, rows);
  const planBar = PLAN_IDS.map((id) => {
    const info = planInfo(id);
    const label = `${info.name}（$${info.priceMonthly}/月）`;
    return id === planId ? bold(cyan(label)) : dim(label);
  }).join(dim(" / "));
  const lines = [
    `${bold(cyan("Go 额度"))} ${dim("·")} 计划 ${planBar} ${dim("· p 切换")}`,
    dim(
      `本月已用 ${formatCost(summary.used)} / 月度总额度 ${formatCost(summary.limit)}` +
        ` · 近 5h ${formatCost(summary.h5)} · 近 7 天 ${formatCost(summary.week)}` +
        ` · 官方规则：5h ≤ 20% / 周 ≤ 50% / 月 ≤ 100%`,
    ),
    dim(
      `${padTo("模型", 28)}${padTo("5 小时窗口", 15)}${padTo("周窗口", 15)}` +
        `${padTo("月窗口", 15)}${padStartTo("剩余", 10)}`,
    ),
  ];
  for (const row of rows) {
    if (row.unknown) {
      lines.push(
        `${padTo(row.name, 28)}${dim("官方价格表未收录")} ${padStartTo(cyan(formatCost(row.month)), 12)}`,
      );
      continue;
    }
    if (row.unlimited) {
      const used = row.month > 0 ? `${dim("· 本月已折算")} ${cyan(formatCost(row.month))}` : dim("· 免费不限量");
      lines.push(`${padTo(row.name, 28)}${green("不限量")} ${used}`);
      continue;
    }
    const remaining = row.remaining ?? 0;
    const remainingText = remaining <= 0 ? red("已用尽") : formatMoney(remaining);
    lines.push(
      `${padTo(row.name, 28)}` +
        `${bar(row.h5Pct)} ${pctText(row.h5Pct)} ` +
        `${bar(row.weekPct)} ${pctText(row.weekPct)} ` +
        `${bar(row.monthPct)} ${pctText(row.monthPct)} ` +
        `${padStartTo(remainingText, 10)}`,
    );
  }
  lines.push("");
  lines.push(dim("额度 = 月额度 × 窗口比例 − 窗口内已用（按官方价折算 token 费用）。"));
  lines.push(dim("DeepSeek 峰谷价、长上下文分档均已计入；周窗口按最近 7 天滚动，月窗口按自然月。"));
  lines.push(dim("官方限流与真实账单以 OpenCode 控制台为准，这里用于提前发现「快用完」。"));
  return lines;
}

export function buildHelpLines() {
  return [
    `${bold(cyan("快捷键"))}`,
    "",
    `${padTo("Tab", 10)}${dim("切换默认档位：免费 ↔ Go（Go 未配密钥时直接弹出输入框）")}`,
    `${padTo("d", 10)}${dim("每日账单：每天的请求次数、token、白嫖 / Go 花费")}`,
    `${padTo("q", 10)}${dim("Go 额度列表：每个模型的 5h / 周 / 月剩余额度")}`,
    `${padTo("s", 10)}${dim("总览：今日 / 累计用量、Go 计划、数据文件位置")}`,
    `${padTo("p", 10)}${dim("在额度界面切换 Go / Go Plus 计划（额度表按计划缩放）")}`,
    `${padTo("?", 10)}${dim("显示本帮助（h 也可以）")}`,
    `${padTo("k", 10)}${dim("设置 / 更换 Go 密钥（保存到 data/secrets.json）")}`,
    `${padTo("Esc", 10)}${dim("返回实时日志")}`,
    `${padTo("↑/↓", 10)}${dim("滚动（日志或面板）")}`,
    `${padTo("PgUp/PgDn", 10)}${dim("整页滚动")}`,
    `${padTo("c", 10)}${dim("清空当前日志（不影响账本）")}`,
    `${padTo("Ctrl+C", 10)}${dim("退出桥")}`,
    "",
    `${bold(cyan("说明"))}`,
    `${padTo("", 10)}${dim("桥把每次请求记进 data/usage.jsonl（重启不丢），按本地日期汇总。")}`,
    `${padTo("", 10)}${dim("免费通道的金额是「白嫖」的等效价值；Go 通道金额会计入订阅额度。")}`,
    `${padTo("", 10)}${dim("会话内切换模型仍用 dsh 的 /model；Tab 改的是 dsh 的默认模型。")}`,
  ];
}
