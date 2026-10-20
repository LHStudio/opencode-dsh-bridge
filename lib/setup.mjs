import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchGoCatalog } from "./catalog.mjs";
import { FALLBACK_MODEL_IDS, GO_CATALOG, goModelSpec, isFreeModel, modelSpec } from "./models.mjs";
import { ICONS, bold, cyan, dim, green, gray, yellow } from "./ui.mjs";

export const MARKER = "# Added by opencode-dsh-bridge";

/** 本桥在 dsh 里注册的两个提供商（免费 Zen / Go 订阅）。 */
export const PROVIDERS = {
  free: {
    id: "opencode-free",
    displayName: "OpenCode Free (bridge)",
    path: "/v1",
    label: "免费",
  },
  go: {
    id: "opencode-go",
    displayName: "OpenCode Go (bridge)",
    path: "/go/v1",
    label: "Go",
  },
};

/** 每档的默认模型：切换默认档位时写入 `agent-default-model`。 */
export const DEFAULT_MODELS = {
  free: { provider: PROVIDERS.free.id, model: "deepseek-v4.1-flash-free" },
  go: { provider: PROVIDERS.go.id, model: "deepseek-v4.1-flash" },
};

export function resolveDshHome(cfg) {
  return cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export async function fetchFreeModelIds(cfg) {
  const sources = [`http://${cfg.host}:${cfg.port}/v1/models`, cfg.modelsUrl];
  for (const source of sources) {
    try {
      const res = await fetch(source, {
        headers: { "user-agent": cfg.ua, accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const ids = (json.data ?? []).map((model) => model.id).filter((id) => isFreeModel(id, cfg.extraFree));
      if (ids.length > 0) return ids;
    } catch {}
  }
  return FALLBACK_MODEL_IDS;
}

/** 本桥是否需要给 dsh 注册 Go 提供商：配了 Go 密钥，或用户显式指定。 */
export function goEnabled(cfg) {
  return Boolean(cfg.goKey) || cfg.goRegister === true;
}

/**
 * 渲染 dsh 的 `llm-pi-ai` 条目（可能同时含 opencode-free 与 opencode-go）。
 */
export function renderProviderBlock(cfg, { freeIds, goIds = [] }) {
  const channels = goIds.length > 0 ? "OpenCode Zen 免费模型 + OpenCode Go 订阅模型" : "OpenCode Zen 免费模型";
  const lines = [
    `${MARKER}：${channels} 经本地桥接入。`,
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
  ];
  lines.push(...renderProviderEntry(cfg, PROVIDERS.free, freeIds, modelSpec));
  if (goIds.length > 0) {
    lines.push(...renderProviderEntry(cfg, PROVIDERS.go, goIds, goModelSpec));
  }
  return lines.join("\n");
}

function renderProviderEntry(cfg, provider, modelIds, specOf) {
  const lines = [
    `      ${provider.id}:`,
    `        displayName: ${provider.displayName}`,
    "        api: openai-completions",
    `        baseURL: http://${cfg.host}:${cfg.port}${provider.path}`,
    "        headers:",
    "          Authorization: Bearer public",
  ];
  if (modelIds.length > 0) {
    lines.push("        models:");
    for (const id of modelIds) {
      const spec = specOf(id);
      lines.push(`          - id: ${id}`);
      lines.push(`            name: ${spec.name}`);
      lines.push(`            input: [${spec.input.join(", ")}]`);
      if (spec.contextWindow) lines.push(`            contextWindow: ${spec.contextWindow}`);
      if (spec.maxTokens) lines.push(`            maxTokens: ${spec.maxTokens}`);
      lines.push(...renderReasoningEfforts(spec.reasoningEfforts));
    }
  }
  return lines;
}

/**
 * 渲染一个模型的 `reasoningEfforts` 映射。
 *
 * dsh 只在模型声明了该字段时才在模型选择器里显示「推理等级」；
 * `false`（非推理模型）不写任何内容，让 UI 保持「未提供推理等级」。
 * `off: ` 留空是有意的：dsh 把它翻译成「不发送 reasoning_effort」。
 */
function renderReasoningEfforts(efforts) {
  if (!efforts) return [];
  const lines = ["            reasoningEfforts:"];
  for (const [level, wire] of Object.entries(efforts)) {
    lines.push(wire === null ? `              ${level}:` : `              ${level}: ${wire}`);
  }
  return lines;
}

function stripTrailingBlank(text) {
  return text.replace(/\s+$/, "");
}

function hasProvidersContent(block) {
  const index = block.findIndex((line) => line.trim() === "providers:");
  if (index === -1) return false;
  const indent = block[index].search(/\S/);
  return block.slice(index + 1).some((line) => line.trim() && line.search(/\S/) > indent);
}

function removeProviderSubtree(block) {
  let result = block;
  for (const provider of Object.values(PROVIDERS)) {
    const start = result.findIndex((line) => line.trim() === `${provider.id}:`);
    if (start === -1) continue;
    const indent = result[start].search(/\S/);
    let end = start + 1;
    while (end < result.length) {
      const line = result[end];
      const lineIndent = line.trim() ? line.search(/\S/) : Infinity;
      if (lineIndent <= indent) break;
      end += 1;
    }
    result = [...result.slice(0, start), ...result.slice(end)];
  }
  return hasProvidersContent(result) ? result : [];
}

function pruneBridgeEntries(existing) {
  const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith(MARKER));
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("- id: llm-pi-ai")) {
      let end = i + 1;
      while (end < lines.length && !lines[end].startsWith("- ")) end += 1;
      out.push(...removeProviderSubtree(lines.slice(i, end)));
      i = end;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function mergeIntoEmptyPatch(existing, block) {
  const remaining = stripTrailingBlank(
    existing
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "[]")
      .join("\n"),
  );
  return `${remaining}\n\n${block}\n`;
}

function appendToPatch(existing, block) {
  return `${stripTrailingBlank(existing)}\n\n${block}\n`;
}

async function profilePatchFiles(cfg) {
  const profilesDir = path.join(resolveDshHome(cfg), "profiles");
  let entries;
  try {
    entries = await fs.readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push({ profile: entry.name, path: path.join(profilesDir, entry.name, "cordis.patch.yml") });
  }
  return files;
}

export { profilePatchFiles };

/** profile 目录名对应的中文说明，只用于展示。 */
export const PROFILE_LABELS = {
  desktop: "DSH 桌面客户端",
  web: "DSH Web / CLI",
};

/**
 * 决定 setup 写哪些 profile。
 *
 * 优先级：显式 `--profile`（可逗号分隔）> 已带本桥标记的 profile（自动跟随）
 * > 同时存在的 desktop / web > 只写 web。
 * 这样用户换机器 / 重装桌面版都不需要再记 profile 名字。
 */
export async function resolveSetupProfiles(cfg) {
  const profilesDir = path.join(resolveDshHome(cfg), "profiles");
  const names = new Set();
  try {
    for (const entry of await fs.readdir(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {}
  const toTarget = (name) => ({ profile: name, path: path.join(profilesDir, name, "cordis.patch.yml") });
  if (cfg.profile && String(cfg.profile).trim()) {
    return String(cfg.profile)
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map(toTarget);
  }
  const marked = [];
  for (const name of [...names].sort()) {
    try {
      const text = await fs.readFile(toTarget(name).path, "utf8");
      if (text.includes(MARKER)) marked.push(name);
    } catch {}
  }
  if (marked.length > 0) return marked.map(toTarget);
  const preferred = ["desktop", "web"].filter((name) => names.has(name));
  return (preferred.length > 0 ? preferred : ["web"]).map(toTarget);
}

/**
 * 把两个提供商的模型列表同步进所有已注册过本桥的 profile。
 *
 * 只改带 {@link MARKER} 的文件，保留其他配置；内容有变化才备份并写入。
 */
export async function syncPatchFiles(cfg, { freeIds, goIds = [] }) {
  const block = renderProviderBlock(cfg, { freeIds, goIds });
  const results = [];
  for (const file of await profilePatchFiles(cfg)) {
    let text;
    try {
      text = await fs.readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(MARKER)) continue;
    const content = appendToPatch(pruneBridgeEntries(text), block);
    if (content === text) {
      results.push({ profile: file.profile, path: file.path, changed: false });
      continue;
    }
    await fs.copyFile(file.path, `${file.path}.bak-bridge-${Date.now()}`);
    await fs.writeFile(file.path, content, "utf8");
    results.push({ profile: file.profile, path: file.path, changed: true });
  }
  return results;
}

/**
 * 切换 dsh 的默认模型（`agent-default-model` 条目）。
 *
 * 只改带本桥标记的 profile，写入前留 `.bak-bridge-*` 备份。
 * 返回 `{ profile, path, previous }` 列表；没有可改的 profile 时返回空数组。
 */
export async function setDefaultModel(cfg, tier, modelId = "") {
  const base = DEFAULT_MODELS[tier];
  if (!base) throw new Error(`unknown tier: ${tier}`);
  const target = { provider: base.provider, model: modelId || base.model };
  const results = [];
  for (const file of await profilePatchFiles(cfg)) {
    let text;
    try {
      text = await fs.readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(MARKER)) continue;
    const previous = readDefaultEntry(text);
    const next = updateDefaultEntry(text, target);
    if (next === text) {
      results.push({ profile: file.profile, path: file.path, previous, changed: false });
      continue;
    }
    await fs.copyFile(file.path, `${file.path}.bak-bridge-${Date.now()}`);
    await fs.writeFile(file.path, next, "utf8");
    results.push({ profile: file.profile, path: file.path, previous, changed: true });
  }
  return results;
}

/** 读出 `agent-default-model` 条目当前的 provider/model，用日志展示改动前状态。 */
function readDefaultEntry(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith("- id: agent-default-model"));
  if (start === -1) return null;
  const previous = { provider: null, model: null };
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("- "); i += 1) {
    const match = /^\s+(provider|model):\s*(\S+)/.exec(lines[i]);
    if (match) previous[match[1]] = match[2];
  }
  return previous.provider || previous.model ? previous : null;
}

function updateDefaultEntry(text, target) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith("- id: agent-default-model"));
  const entryLines = [
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    `    provider: ${target.provider}`,
    `    model: ${target.model}`,
  ];
  if (start === -1) {
    const head = stripTrailingBlank(lines.join("\n"));
    return `${head}\n${entryLines.join("\n")}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("- ")) end += 1;
  const block = lines.slice(start, end);
  const configIndex = block.findIndex((line) => /^\s+config:\s*$/.test(line));
  if (configIndex === -1) {
    block.splice(1, 0, "  config:", `    provider: ${target.provider}`, `    model: ${target.model}`);
  } else {
    const indent = block[configIndex].search(/\S/) + 2;
    const pad = " ".repeat(indent);
    let insertAt = configIndex + 1;
    for (let i = configIndex + 1; i < block.length; i += 1) {
      if (!/^\s+(provider|model):/.test(block[i])) break;
      insertAt = i + 1;
    }
    const kept = block.filter((line) => !/^\s+(provider|model):/.test(line));
    const shift = block.length - kept.length;
    insertAt -= shift;
    kept.splice(insertAt, 0, `${pad}provider: ${target.provider}`, `${pad}model: ${target.model}`);
    block.length = 0;
    block.push(...kept);
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

export async function runSetup(cfg) {
  const dshHome = resolveDshHome(cfg);
  const targets = await resolveSetupProfiles(cfg);
  const explicit = Boolean(cfg.profile && String(cfg.profile).trim());

  console.log("");
  console.log(`${bold(`${ICONS.bolt} opencode-dsh-bridge setup`)}`);
  console.log(`   ${gray("DSH 目录".padEnd(6))}  ${dshHome}`);
  const targetLabels = targets.map((target) =>
    PROFILE_LABELS[target.profile]
      ? `${target.profile}（${PROFILE_LABELS[target.profile]}）`
      : target.profile,
  );
  console.log(`   ${gray("目标档".padEnd(6))}  ${targetLabels.join("、")}${explicit ? "" : dim("（自动检测）")}`);

  const freeIds = await fetchFreeModelIds(cfg);
  const vision = freeIds.filter((id) => modelSpec(id).input.includes("image"));
  console.log(`   ${gray("免费模型".padEnd(6))}  ${freeIds.length} 个（${vision.length} 个支持图片）`);

  let goIds = [];
  if (goEnabled(cfg)) {
    const go = await fetchGoCatalog(cfg);
    goIds = go.ids;
    const goVision = goIds.filter((id) => goModelSpec(id).input.includes("image"));
    console.log(`   ${gray("Go 模型".padEnd(6))}  ${goIds.length} 个（${goVision.length} 个支持图片）`);
    if (!cfg.goKey) {
      console.log(`   ${gray("Go 密钥".padEnd(6))}  ${yellow("未配置")}${dim("（注册了提供商，但请求会返回 401，直到设置密钥）")}`);
    }
  } else {
    console.log(
      `   ${gray("Go 模型".padEnd(6))}  ${dim("未启用")}` +
        `${dim("（设置 OPENCODE_GO_API_KEY、--go-key，或在 TUI 里按 k 输入密钥）")}`,
    );
  }

  const block = renderProviderBlock(cfg, { freeIds, goIds });
  const written = [];
  const backups = [];

  for (const target of targets) {
    let existing = null;
    try {
      existing = await fs.readFile(target.path, "utf8");
    } catch {}

    const pruned = existing === null ? null : pruneBridgeEntries(existing);
    const effective = (pruned ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n")
      .trim();

    if (existing !== null) {
      const backupPath = `${target.path}.bak-bridge-${Date.now()}`;
      await fs.copyFile(target.path, backupPath);
      backups.push(backupPath);
    }

    if (existing === null || effective === "" || effective === "[]") {
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      const content = existing === null ? block + "\n" : mergeIntoEmptyPatch(pruned, block);
      await fs.writeFile(target.path, content, "utf8");
    } else {
      await fs.writeFile(target.path, appendToPatch(pruned, block), "utf8");
    }
    written.push(target);
  }

  const registered = [PROVIDERS.free.displayName, ...(goIds.length ? [PROVIDERS.go.displayName] : [])];
  console.log(
    `   ${gray("结果".padEnd(6))}  ${green(`${ICONS.ok} 已写入 ${written.map((target) => target.profile).join("、")}`)}` +
      `${dim(` · ${registered.join(" · ")}`)}`,
  );
  for (const backupPath of backups) {
    console.log(`   ${gray("备份".padEnd(6))}  ${dim(backupPath)}`);
  }
  if (!explicit && targets.length > 1) {
    console.log(
      `   ${dim("说明")}  desktop 是 DSH 桌面客户端的 profile，web 是 Web / CLI 的 profile；` +
        `两个都装了就会都写。只想写一个用 --profile desktop 或 --profile web。`,
    );
  }

  if (cfg.setDefault) {
    const changed = await setDefaultModel(cfg, cfg.tier ?? "free");
    if (changed.length > 0) {
      console.log(
        `   ${gray("默认档位".padEnd(6))}  ${green(`${ICONS.ok} ${cfg.tier ?? "free"}`)}` +
          `${dim(`（${changed.map((item) => item.profile).join("、")}）`)}`,
      );
    }
  }

  console.log("");
  console.log(`${bold("下一步")}`);
  console.log(`   ${cyan("1.")} 启动桥      ${bold(`node bin.mjs start --port ${cfg.port}`)}`);
  console.log(`   ${cyan("2.")} 健康检查    ${dim(`http://${cfg.host}:${cfg.port}/health`)}`);
  console.log(`   ${cyan("3.")} 完全退出并重开 DeepSeek Harness，在 /model 里选`);
  console.log(`      ${cyan(PROVIDERS.free.displayName)}${goIds.length ? ` 或 ${cyan(PROVIDERS.go.displayName)}` : ""} 下的模型。`);
  console.log("");
  console.log(
    `   ${dim("提示")} 桥的终端界面：${bold("Tab")} 切档（Go 没密钥会直接要你输入）、` +
      `${bold("d")} 每日账单、${bold("q")} Go 额度、${bold("k")} 设置密钥、${bold("?")} 帮助；` +
      `会话内切换模型用 dsh 的 ${bold("/model")}。`,
  );
  console.log(
    `            命令行也可以看：${bold("node bin.mjs stats")} / ${bold("node bin.mjs quota")}；` +
      `密钥保存在 ${dim("data/secrets.json")}（不会进 git）。`,
  );
  console.log("");
}
