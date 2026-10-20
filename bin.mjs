#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { startServer, probeGoKey } from "./lib/server.mjs";
import { MARKER, PROFILE_LABELS, profilePatchFiles, resolveDshHome, runSetup } from "./lib/setup.mjs";
import { DEFAULT_EXTRA_FREE } from "./lib/models.mjs";
import { VERSION } from "./lib/version.mjs";
import { PLAN_IDS, normalizePlan, quotaRows, quotaSummary } from "./lib/goQuota.mjs";
import { buildDailyLines, buildQuotaLines } from "./lib/panels.mjs";
import {
  allTimeTotals,
  clearGoKey,
  configureDataDir,
  dailySummary,
  dataDirectory,
  dataPaths,
  goUsageWindows,
  loadState,
  saveGoKey,
  savedGoKey,
  todayTotals,
} from "./lib/store.mjs";

if (process.platform === "win32" && process.stdout.isTTY) {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {}
}

const HELP = `
${"🌉"} opencode-dsh-bridge —— 把 OpenCode Zen 免费模型 / Go 订阅模型接入 DeepSeek Harness

用法：
  node bin.mjs start [选项]              启动本地桥接服务（默认命令）
  node bin.mjs setup [选项]              把桥注册为 dsh 模型提供商（写入 cordis.patch.yml）
  node bin.mjs key <set|show|clear>      管理 Go 密钥（保存在 data/secrets.json；set 可加 --verify 先验证）
  node bin.mjs stats [--days 14]         查看每日请求次数 / 白嫖金额 / Go 花费
  node bin.mjs quota [--plan go|go-plus] 查看 Go 额度剩余（按官方价本地折算）
  node bin.mjs doctor                    自检：Node、数据目录、DSH profile、端口
  node bin.mjs help                      显示本帮助

通用选项：
  --port <n>           桥监听端口（默认 8787）
  --host <addr>        监听地址（默认 127.0.0.1）
  --profile <name>     setup 写入的 dsh profile；逗号分隔可写多个（默认自动检测 desktop/web）
  --dsh-home <dir>     dsh 主目录（默认 %DSH_HOME% 或 ~/.dsh）
  --data-dir <dir>     数据目录（默认 <项目目录>/data；也可用 BRIDGE_DATA_DIR）
  --json               stats / quota / doctor / key show 输出 JSON
  --quiet              不打印逐条请求日志（启动摘要和警告仍输出）
  -h, --help           显示本帮助

免费通道（OpenCode Zen 免费模型）：
  --upstream <url>     对话上游（默认 https://opencode.ai/inference/openai/v1）
  --models-url <url>   模型列表上游（默认 https://opencode.ai/zen/v1/models）
  --key <key>          可选 OpenCode/Zen API Key（默认匿名免费层）
  --ua <ua>            发给上游的 User-Agent（默认 opencode/1.19.3）
  --client <name>      x-opencode-client 值（默认 cli）
  --project <name>     x-opencode-project 值（默认 global）
  --allow-paid         不拦截付费模型
  --extra-free <ids>   额外放行的模型 id，逗号分隔（默认 big-pickle）

Go 通道（OpenCode Go 订阅，$10/月起）：
  --go-key <key>       Go 凭据；也可用环境变量 OPENCODE_GO_API_KEY
  --go-upstream <url>  Go 对话上游（默认 https://opencode.ai/inference/go/openai/v1）
  --go-ua <ua>         Go 通道 User-Agent（默认 opencode-dsh-bridge/${VERSION}）
  --go-plan <plan>     Go 计划：go（$10/月）或 go-plus（$40/月），影响额度表
  --go-register        未配 Go 密钥也先注册 Go 提供商（模型可见，但请求返回 400 go_credential_missing）
  --tier <free|go>     setup 写 agent-default-model 用的档位（运行中的桥以 data/state.json 为准，默认 free）

运行行为：
  --fallback           429/5xx 时自动换下一个同档模型重试
  --sync-interval <s>  模型列表自动同步间隔秒数（默认 600，0 关闭）
  --no-sync            关闭模型列表自动同步
  --set-default        setup 时把 agent-default-model 写成 --tier 档的默认模型
  --no-auto-default    按 Tab 切档时不改写 dsh 的 agent-default-model

终端界面快捷键：
  Tab 切档（免费 ↔ Go；切到 Go 没密钥时直接让你输入）
  d 每日账单   q Go 额度   s 总览   p 切 Go / Go Plus（额度面板内）
  k 设置 Go 密钥   ? / h 帮助   Esc 返回日志   c 清屏
  ↑/↓ PgUp/PgDn 滚动   Ctrl+C 退出

环境变量：PORT、BRIDGE_HOST、BRIDGE_UPSTREAM、BRIDGE_MODELS_URL、
OPENCODE_ZEN_API_KEY、OPENCODE_GO_API_KEY、BRIDGE_GO_UPSTREAM、BRIDGE_GO_UA、
BRIDGE_GO_PLAN、BRIDGE_DATA_DIR、BRIDGE_UA、BRIDGE_EXTRA_FREE、
BRIDGE_SYNC_INTERVAL、BRIDGE_TIER
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: process.env.PORT ?? "8787" },
    host: { type: "string", default: process.env.BRIDGE_HOST ?? "127.0.0.1" },
    upstream: {
      type: "string",
      default: process.env.BRIDGE_UPSTREAM ?? "https://opencode.ai/inference/openai/v1",
    },
    "models-url": {
      type: "string",
      default: process.env.BRIDGE_MODELS_URL ?? "https://opencode.ai/zen/v1/models",
    },
    key: { type: "string", default: process.env.OPENCODE_ZEN_API_KEY ?? "" },
    ua: { type: "string", default: process.env.BRIDGE_UA ?? "opencode/1.19.3" },
    client: { type: "string", default: "cli" },
    project: { type: "string", default: "global" },
    "allow-paid": { type: "boolean", default: false },
    fallback: { type: "boolean", default: false },
    "extra-free": { type: "string", default: process.env.BRIDGE_EXTRA_FREE ?? "" },
    "go-key": { type: "string", default: process.env.OPENCODE_GO_API_KEY ?? "" },
    "go-upstream": {
      type: "string",
      default: process.env.BRIDGE_GO_UPSTREAM ?? "https://opencode.ai/inference/go/openai/v1",
    },
    "go-ua": { type: "string", default: process.env.BRIDGE_GO_UA ?? "" },
    "go-register": { type: "boolean", default: false },
    "go-plan": { type: "string", default: process.env.BRIDGE_GO_PLAN ?? "" },
    plan: { type: "string", default: "" },
    tier: { type: "string", default: process.env.BRIDGE_TIER ?? "free" },
    "sync-interval": {
      type: "string",
      default: process.env.BRIDGE_SYNC_INTERVAL ?? "600",
    },
    "no-sync": { type: "boolean", default: false },
    "set-default": { type: "boolean", default: false },
    "no-auto-default": { type: "boolean", default: false },
    profile: { type: "string", default: "" },
    "dsh-home": { type: "string", default: "" },
    "data-dir": { type: "string", default: process.env.BRIDGE_DATA_DIR ?? "" },
    days: { type: "string", default: "14" },
    verify: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0] ?? "start";

if (values.help || command === "help") {
  console.log(HELP.trim());
  process.exit(0);
}

const extraFree = values["extra-free"]
  ? values["extra-free"].split(",").map((id) => id.trim()).filter(Boolean)
  : DEFAULT_EXTRA_FREE;

const syncSeconds = Number(values["sync-interval"]);
if (!Number.isFinite(syncSeconds) || syncSeconds < 0) {
  console.error(`invalid --sync-interval: ${values["sync-interval"]}`);
  process.exit(1);
}

if (values.tier !== "free" && values.tier !== "go") {
  console.error(`invalid --tier: ${values.tier}（只能是 free 或 go）`);
  process.exit(1);
}

const planArg = values.plan || values["go-plan"];
if (planArg && !PLAN_IDS.includes(planArg)) {
  console.error(`invalid --plan / --go-plan: ${planArg}（只能是 go 或 go-plus）`);
  process.exit(1);
}

const cfg = {
  version: VERSION,
  port: Number(values.port),
  host: values.host,
  upstream: values.upstream.replace(/\/+$/, ""),
  goUpstream: values["go-upstream"].replace(/\/+$/, ""),
  modelsUrl: values["models-url"],
  key: values.key,
  goKey: values["go-key"].trim(),
  goPlan: planArg,
  ua: values.ua,
  goUa: values["go-ua"] || `opencode-dsh-bridge/${VERSION}`,
  client: values.client,
  project: values.project,
  allowPaid: values["allow-paid"],
  fallback: values.fallback,
  extraFree,
  sync: !values["no-sync"] && syncSeconds > 0,
  syncMs: syncSeconds * 1000,
  tier: values.tier,
  autoDefault: !values["no-auto-default"],
  setDefault: values["set-default"],
  goRegister: values["go-register"],
  profile: values.profile,
  dshHome: values["dsh-home"],
  dataDir: values["data-dir"],
  verify: values.verify,
  json: values.json,
  quiet: values.quiet,
};

if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
  console.error(`invalid port: ${values.port}`);
  process.exit(1);
}

if (cfg.dataDir) configureDataDir(cfg.dataDir);
// 保存过的 Go 密钥当作默认凭据：start / setup / doctor 都不用再传 --go-key。
if (!cfg.goKey) cfg.goKey = savedGoKey();

const mask = (key) => (key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`);

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function runKeyCommand() {
  const action = positionals[1] ?? "show";
  if (action === "show") {
    const saved = savedGoKey();
    if (cfg.json) {
      console.log(JSON.stringify({ saved: Boolean(saved), key: saved ? mask(saved) : null }, null, 2));
      return;
    }
    console.log("");
    console.log(saved ? `   Go 密钥   ${mask(saved)}（data/secrets.json）` : "   还没有保存 Go 密钥");
    console.log(`   保存位置  ${dataPaths().secrets}`);
    console.log("");
    return;
  }
  if (action === "clear") {
    const existed = Boolean(savedGoKey());
    clearGoKey();
    console.log(existed ? "   已删除保存的 Go 密钥" : "   没有保存过 Go 密钥");
    return;
  }
  if (action !== "set") {
    console.error(`未知的 key 操作：${action}（可用 set / show / clear）`);
    process.exit(1);
  }
  let value = positionals[2] ?? "";
  if (!value) {
    if (process.stdin.isTTY) {
      value = await ask("   粘贴 Go 密钥后回车：");
    } else {
      value = await readAllStdin();
    }
  }
  if (!value) {
    console.error("没有提供密钥；也可以直接：node bin.mjs key set sk-xxx");
    process.exit(1);
  }
  if (cfg.verify) {
    const check = await probeGoKey(cfg, value);
    if (!check.ok) {
      console.error(`   ${check.message}`);
      process.exit(1);
    }
    console.log(`   验证通过${check.note ? `（${check.note}）` : ""}`);
  }
  saveGoKey(value);
  console.log(`   已保存 Go 密钥 ${mask(value)} → ${dataPaths().secrets}`);
  console.log("   重启桥后生效；桥启动时会自动启用 Go 通道，TUI 里按 Tab 切档。");
}

async function runStatsCommand() {
  const days = Math.max(1, Math.min(120, Number(values.days) || 14));
  if (cfg.json) {
    const summary = dailySummary(days);
    console.log(JSON.stringify({ days: summary.days, totals: summary.totals, allTime: allTimeTotals() }, null, 2));
    return;
  }
  console.log(buildDailyLines(Date.now(), days).join("\n"));
}

async function runQuotaCommand() {
  const plan = normalizePlan(planArg || loadState().plan);
  if (cfg.json) {
    const rows = quotaRows(plan, goUsageWindows());
    console.log(
      JSON.stringify({ plan, source: "https://opencode.ai/docs/go/", summary: quotaSummary(plan, rows), rows }, null, 2),
    );
    return;
  }
  console.log(buildQuotaLines(plan, Date.now()).join("\n"));
}

async function runDoctorCommand() {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 18 || (major === 18 && minor >= 17);
  add(nodeOk, "Node.js", `v${process.versions.node}${nodeOk ? "" : "（需要 >= 18.17）"}`);

  try {
    await fs.mkdir(dataDirectory(), { recursive: true });
    const probe = path.join(dataDirectory(), ".write-test");
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    add(true, "数据目录", `${dataDirectory()}（可写）`);
  } catch (error) {
    add(false, "数据目录", `${dataDirectory()}：${error.message}`);
  }

  const today = todayTotals();
  const allTime = allTimeTotals();
  add(
    true,
    "用量账本",
    `${dataPaths().usage} · 今日 ${today.requests} 次请求 · 累计 ${allTime.requests} 次`,
  );

  const key = savedGoKey();
  add(Boolean(key), "Go 密钥", key ? `${mask(key)}（data/secrets.json）` : "未保存（TUI 按 k 或 node bin.mjs key set）");

  const dshHome = resolveDshHome(cfg);
  try {
    const files = await profilePatchFiles(cfg);
    const marked = [];
    for (const file of files) {
      try {
        const text = await fs.readFile(file.path, "utf8");
        if (text.includes(MARKER)) marked.push(file.profile);
      } catch {}
    }
    add(
      marked.length > 0,
      "DSH profile",
      marked.length > 0
        ? `${dshHome} · 已注册 ${marked.map((name) => `${name}${PROFILE_LABELS[name] ? `（${PROFILE_LABELS[name]}）` : ""}`).join("、")}`
        : `${dshHome} · 还没有带桥标记的 profile，先运行 node bin.mjs setup`,
    );
  } catch (error) {
    add(false, "DSH profile", `${dshHome}：${error.message}`);
  }

  let health = null;
  try {
    const response = await fetch(`http://${cfg.host}:${cfg.port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) health = await response.json();
  } catch {}
  add(
    Boolean(health),
    "桥服务",
    health
      ? `运行中 · 档位 ${health.tier}${health.plan ? ` · 计划 ${health.plan}` : ""} · 免费模型 ${health.free?.count ?? 0} 个` +
          `${health.go?.enabled ? ` · Go 模型 ${health.go.count} 个` : " · Go 未启用"}`
      : `未在 http://${cfg.host}:${cfg.port} 运行（正常，只在用 DSH 时需要启动）`,
  );

  if (cfg.json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }
  console.log("");
  console.log("   🌉 opencode-dsh-bridge doctor");
  console.log("");
  for (const check of checks) {
    console.log(`   ${check.ok ? "✓" : "·"} ${check.label.padEnd(10)} ${check.detail}`);
  }
  console.log("");
}

async function main() {
  if (command === "start") {
    startServer(cfg);
    return;
  }
  if (command === "setup") {
    await runSetup(cfg);
    return;
  }
  if (command === "key") {
    await runKeyCommand();
    return;
  }
  if (command === "stats") {
    await runStatsCommand();
    return;
  }
  if (command === "quota") {
    await runQuotaCommand();
    return;
  }
  if (command === "doctor") {
    await runDoctorCommand();
    return;
  }
  console.error(`未知命令：${command}`);
  console.log(HELP.trim());
  process.exit(1);
}

main().catch((error) => {
  console.error(`${command} 失败：${error.message}`);
  process.exit(1);
});
