# opencode-dsh-bridge

一个本地运行、零依赖的 Node.js（>= 18.17）OpenAI 兼容桥：把 **OpenCode Zen 免费模型**（`/v1`）和 **OpenCode Go 订阅模型**（`/go/v1`）作为普通模型提供商接入 **DeepSeek Harness（DSH）**。

桥监听 `127.0.0.1:8787`，使用 OpenAI Chat Completions 协议（支持流式），再把每个请求转发到对应的 `opencode.ai` 推理端点。DSH 里会看到 `opencode-free` 和 `opencode-go` 两个提供商：日常用免费模型，需要更强模型时切到 Go 订阅。所有内容都在本机运行，除了发往 `opencode.ai` 的模型请求/列表请求，以及定期读取 `models.dev` 的公开价格目录之外，不会有任何数据离开你的机器。

> **非官方项目。** 本项目与 OpenCode、DeepSeek 均无隶属、背书或支持关系，只是个人互操作工具。
>
> **金额均为估算。** 面板、`stats`、`quota` 和 `/usage` 里的美元数字，都是根据你自己的请求账本在本地折算出来的，不是账单，也不是从官方计费系统读取的。

## 功能

- **一个进程，两条通道。** 免费 Zen 模型走 `/v1`，Go 模型走 `/go/v1`；每个端点只接受自己目录里的模型。
- **快捷键切档。** TUI 里按 `Tab` 在免费/Go 之间切换默认档位；会话内的即时切换仍用 DSH 自己的 `/model`。
- **自动索要 Go 密钥。** 没有凭据时切到 Go，会直接弹出输入框；密钥先验证再保存。
- **持久化本地账本。** `data/usage.jsonl` 每次模型调用一行，每日请求数、成功/失败/中断、token、免费档“白嫖”金额和 Go 花费重启不丢。
- **TUI 仪表盘。** 实时日志，加上每日账单（`d`）、Go 额度（`q`）、总览（`s`）、帮助（`?`/`h`）视图，可滚动，密钥输入会打码。
- **本地 Go 额度估算。** 按官方每模型月额度、5 小时/周/月三个窗口、DeepSeek 峰谷价和长上下文分档，从账本换算；在额度面板按 `p` 切换 Go（$10/月）/ Go Plus（$40/月）。
- **命令行工具。** `stats`、`quota`、`doctor`，都支持 `--json`。
- **多 profile 自动检测。** 自动识别 `desktop` 和 `web`，只写自己的标记块，可重复执行。
- **可移植。** 代码里没有绝对路径；运行数据默认在 `<仓库>/data`，可用 `--data-dir` 或 `BRIDGE_DATA_DIR` 搬走。

## 快速开始

要求：[Node.js](https://nodejs.org/) >= 18.17，以及可用的 DeepSeek Harness。项目零依赖，不需要 `npm install`。

```shell
git clone https://github.com/<your-name>/opencode-dsh-bridge.git
cd opencode-dsh-bridge
# 启动桥（使用 DSH 期间保持这个窗口开着）：
start.cmd                        # Windows，或直接双击它
chmod +x start.sh && ./start.sh  # macOS / Linux
node bin.mjs start               # 任意平台
```

然后把桥注册为 DSH 提供商，并重启 DSH：

```shell
node bin.mjs setup      # 写入 ~/.dsh/profiles/<profile>/cordis.patch.yml
node bin.mjs doctor     # 可选自检：Node、数据目录、profile、端口
```

完全退出并重开 DSH，然后在模型选择器里选：

- **OpenCode Free (bridge)** —— 例如 `deepseek-v4.1-flash-free`
- **OpenCode Go (bridge)** —— 例如 `deepseek-v4.1-flash`（配置 Go 密钥后才会出现）

`node bin.mjs setup` 在桥启动前或启动后都能跑；桥没开时会回退到上游模型列表和内置 Go 目录。

## Windows 桌面快捷方式

`scripts/create-shortcut.ps1` 会在桌面创建名为“OpenCode 桥接器”的快捷方式，双击后打开 `cmd /k` 窗口运行桥：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
# 可选：-Destination "<某个目录>" -Name "我的桥"
```

快捷方式实际调用 `start.cmd`：启动失败时窗口会停住让你看清报错（正常 `Ctrl+C` 退出不会暂停）。关掉窗口即停止桥。

## 使用 OpenCode Go

Go 模型需要 OpenCode Go 订阅和 API Key：

1. 在 <https://opencode.ai/go> 订阅（Go $10/月，Go Plus $40/月）。
2. 在 OpenCode 控制台创建 API Key。
3. 用以下任一方式把密钥交给桥：

```shell
# 1）存一次，之后每次启动自动读取
node bin.mjs key set sk-...
node bin.mjs key set sk-... --verify   # 先用一次极小的 Go 请求验证

# 2）启动时传入
node bin.mjs start --go-key sk-...
# 或：OPENCODE_GO_API_KEY=sk-... node bin.mjs start

# 3）在 TUI 里粘贴
# 按 k（或在免费档按 Tab）；密钥会先验证，再保存并启用 Go。
```

密钥保存在 `data/secrets.json`，在 POSIX 系统上权限为 `600`，不会写进账本，在 TUI 和 CLI 里始终打码显示（`sk-a…wxyz`）。命令行/环境变量优先于已保存的密钥。`key set` 后需要重启桥；`data/` 已在 `.gitignore` 中，保存的密钥不会被提交。

## 切换档位

两个“切换”不是一回事，别用混：

| 操作 | 位置 | 效果 |
| --- | --- | --- |
| `Tab` | 桥的 TUI | 切换桥的默认档位（`free` ↔ `go`）。除非禁用，还会把 DSH 的 `agent-default-model` 改成该档的默认模型。**重启 DSH** 后新默认值才生效。 |
| `/model` | DSH 内 | 立即切换当前会话使用的模型；不用重启，也不改任何文件。 |

桥不会在两个通道之间偷换模型 id：免费模型只在 `/v1`，Go 模型只在 `/go/v1`。运行档位从 `data/state.json` 恢复（只有存在凭据时才可能是 Go）；用 `Tab` 或 `POST /tier` 切换，`--no-auto-default` 让 `Tab` 不修改 DSH 的默认模型。

## TUI 快捷键

| 按键 | 作用 |
| --- | --- |
| `Tab` | 切换默认档位（`free` ↔ `go`）；没保存 Go 密钥时会直接弹出输入框 |
| `d` | 每日账单：请求、成功、失败、中断、token、免费档节省、Go 花费 |
| `q` | Go 额度面板（每个模型的 5 小时 / 周 / 月剩余额度） |
| `s` | 总览：今日与累计用量、Go 计划、上游地址、数据目录 |
| `p` | 在额度面板内切换 Go / Go Plus |
| `k` | 设置或粘贴 Go 密钥（任意视图可用） |
| `?` / `h` | 帮助 |
| `Esc` | 返回实时日志 |
| `↑` / `↓` | 向上 / 向下滚动一行 |
| `PgUp` / `PgDn` | 向上 / 向下翻一页（滚轮同样可用） |
| `c` | 清空可见日志（不会清账本） |
| `Ctrl+C` | 退出 |

仪表盘头部显示今日请求、token、花费与节省；所有面板都可滚动，内容超出时底部显示当前可见范围，实时日志在后台继续追加。

## CLI 参考

运行 `node bin.mjs help`（或 `-h`）查看内置帮助。命令：

| 命令 | 说明 |
| --- | --- |
| `start`（默认） | 启动桥、仪表盘和 HTTP 服务。 |
| `setup` | 在检测到的 DSH profile 里注册 `opencode-free`（有密钥或 `--go-register` 时也注册 `opencode-go`）。 |
| `key set\|show\|clear` | 保存（可加 `--verify`）、打码显示或删除 `data/secrets.json` 里的 Go 密钥。 |
| `stats [--days N]` | 打印账本汇总的每日账单（默认 14 天，范围 1–120）。 |
| `quota [--plan go\|go-plus]` | 按指定计划打印每个模型的 Go 额度估算。 |
| `doctor` | 自检 Node 版本、数据目录、账本、Go 密钥、DSH profile、桥是否在运行。 |

通用选项（所有命令可用）：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--port <n>` | `8787`（环境变量 `PORT`） | 桥监听端口。 |
| `--go-key <key>` | 环境变量 `OPENCODE_GO_API_KEY` | 本次运行的 Go 凭据，不落盘。 |
| `--go-plan <plan>` | 环境变量 `BRIDGE_GO_PLAN` / 已保存计划 | `go` 或 `go-plus`，影响额度表。 |
| `--data-dir <dir>` | `<仓库>/data`（环境变量 `BRIDGE_DATA_DIR`） | `state.json`、`secrets.json`、`usage.jsonl` 所在目录。 |
| `--profile <names>` | 自动检测 | `setup` 要写入的 DSH profile，逗号分隔。 |
| `--json` | 关 | `stats`、`quota`、`doctor`、`key show` 输出 JSON。 |
| `--no-sync` | 关 | 关闭模型列表定期刷新（默认每 600 秒）。 |
| `--no-auto-default` | 关 | 切档时不改写 DSH 的 `agent-default-model`。 |
| `--go-register` | 关 | 没有密钥也先注册 Go 提供商；DSH 里能看到它，但在配置密钥前 Go 请求会返回 `400 go_credential_missing`。 |
| `--quiet` | 关 | 不打印每次请求的日志；警告和启动横幅仍会显示。 |

其它真实存在的选项：`--host`（默认 `127.0.0.1`）、`--tier free|go`（决定 `setup --set-default` 写入哪个档位；运行中的桥从 `data/state.json` 恢复档位）、`--set-default`（配合 `setup`）、`--sync-interval <秒>`、`--fallback`、`--allow-paid`、`--extra-free <ids>`、`--upstream`、`--models-url`、`--key`、`--ua`、`--client`、`--project`、`--go-upstream`、`--go-ua`、`--dsh-home`。

## DSH 配置

`node bin.mjs setup` 写入 `~/.dsh/profiles/<profile>/cordis.patch.yml`。这里的 profile 是 DSH 的配置目录，**不是** Windows 的桌面文件夹：`desktop` 是 DSH 桌面客户端 profile，`web` 是 DSH Web/CLI profile。两者存在时都会被写入；也可以用 `--profile desktop`（或逗号分隔的多个名字）指定。

桥只拥有一个带标记的块。重复运行 `setup` 会先删掉旧的 `opencode-*` 提供商定义和标记行，再写入新块，其它条目原样保留。只要 `setup` 改动了文件，就会先把原文件复制为 `<文件>.bak-bridge-<时间戳>`。DSH 只在启动时读取这份配置，所以切换默认档位后要重启 DSH。下面是一个精简示例：

```yaml
# Added by opencode-dsh-bridge：OpenCode Zen 免费模型 + OpenCode Go 订阅模型 经本地桥接入。
- id: llm-pi-ai
  config:
    providers:
      opencode-free: { displayName: OpenCode Free (bridge), api: openai-completions,
        baseURL: http://127.0.0.1:8787/v1, headers: { Authorization: Bearer public },
        models: [{ id: deepseek-v4.1-flash-free }] }  # 完整能力字段按模型自动生成
      # opencode-go 结构相同，baseURL 为 http://127.0.0.1:8787/go/v1，模型 id 形如 deepseek-v4.1-flash
```

`--set-default`（以及 TUI 里的 `Tab`，除非加 `--no-auto-default`）还会改写已有的默认模型条目：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-free         # Go 档时为 opencode-go
    model: deepseek-v4.1-flash-free # Go 档时为 deepseek-v4.1-flash
```

## HTTP 接口

全部为 OpenAI 兼容接口，只绑定本机。已开启 CORS（`access-control-allow-origin: *`，方法 `GET, POST, OPTIONS`），浏览器客户端可以直接调用；支持 `"stream": true`，按 SSE 透传。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 状态：档位、计划、两个模型目录、价格快照、凭据标记。 |
| `GET` | `/tier` | `{ tier, plan, goEnabled, goCredential }`。 |
| `POST` | `/tier` | 请求体 `{"tier":"free"\|"go"}`；切换档位，并按配置改写 DSH 默认模型。 |
| `GET` | `/usage` | 每日数据、合计、累计和 Go 额度估算行。 |
| `GET` | `/v1/models` | 免费通道模型列表（`object: "list"`）。 |
| `POST` | `/v1/chat/completions` | 免费通道对话（流式或 JSON）。 |
| `GET` | `/go/v1/models` | Go 通道模型列表。 |
| `POST` | `/go/v1/chat/completions` | Go 通道对话。 |

错误使用 OpenAI 错误结构。通道用错时返回 `403 model_not_allowed`，并提示正确的端点；Go 端点没配密钥时返回 `400 go_credential_missing`。

## 用量账本与 Go 额度

每个真正发往模型的请求（成功、失败、中断）都会向 `data/usage.jsonl` 追加一行 JSON。面板、`stats`、`quota` 和 `/usage` 都基于这个文件汇总，因此历史在重启和迁移数据目录后仍然存在。启动时会清理超过 400 天的记录。

免费档的“白嫖”是按 `models.dev` 公布的模型价格折算的等效价值——你没有实际支付的金额。Go 花费则是 token 用量乘以官方 Go 价格表。

**Go 额度是本地估算。** OpenCode 没有公开的用量/额度查询接口，桥只能用自己账本里的用量，按 <https://opencode.ai/docs/go/> 公布的额度和价格来折算。它的用途是提前发现“快用完了”；官方控制台及其限流才是权威。通过其它客户端、或安装本桥之前的请求，这里都看不到。

估算采用的官方规则：

- 每个模型有月度美元额度，分 `Go` 与 `Go Plus` 两列（例如 DeepSeek V4.1 Flash **$80 / $160**，GLM-5.3-Flash **$60 / $180**，Kimi K3 **$15 / $60**）。
- 窗口：5 小时 ≤ 月额度的 20%，一周 ≤ 50%，一个月 ≤ 100%。
- Go 内不限量的模型会标为“不限量”：`beam-free`、`longcat-2.5-preview-free`、`minimax-m3.1-flash-free`。
- DeepSeek V4.1 Flash / V4 Pro 有峰谷价：周一至周五 **01:00–04:00** 与 **06:00–10:00 UTC** 为峰时，其余为谷时；长上下文模型（Qwen3.7 Plus 256K、Grok 4.7 200K、GPT-6 Luna 272K、Claude Haiku 5.5 100K）按“输入 + 输出 token”切换价格档。

## 数据与隐私

| 文件 | 内容 |
| --- | --- |
| `data/state.json` | 当前档位与 Go 计划。 |
| `data/secrets.json` | Go 密钥；支持的系统上权限 `600`，任何展示处都会打码。 |
| `data/usage.jsonl` | 只追加的请求账本，每次模型调用一行，400 天后清理。 |

数据目录默认 `<仓库>/data`；用 `--data-dir` 或 `BRIDGE_DATA_DIR` 可以改到别处（同步盘或备份目录都可以）。`data/` 已列入 `.gitignore`，请保持这样。项目不收集遥测、不访问分析服务、密钥从不写日志。删除 `data/usage.jsonl` 会重置账单和额度估算；删除 `data/state.json` 会重置档位/计划选择。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动报 `EADDRINUSE` | 端口上已经有一个桥在跑。先停掉它，或用 `--port 8788` 换端口（换端口后要重跑 `setup`，让 DSH 指向新端口）。 |
| Go 请求返回 `401` / `invalid credential` | 密钥错误、没复制完整或属于别的账号。重新粘贴（`node bin.mjs key set sk-... --verify`）后重启桥。 |
| `GET /inference/go/openai/v1/models` 返回 `404` | 正常现象：Go 上游没有模型列表接口。桥用自己的 `/go/v1/models`（内置目录 / models.dev）提供列表。 |
| 通道混用时出现 `403 model_not_allowed`（未知路径才是 `404`） | 免费模型只在 `/v1`，Go 模型只在 `/go/v1`。在 DSH 里选对应提供商，或先切档再选模型。 |
| 额度数字和官方控制台对不上 | 额度面板是根据本桥账本做的本地估算，不是官方账单。以 OpenCode 控制台为准。 |
| `setup` 之后 DSH 还是旧模型，或按 `Tab` 当前对话没变 | `Tab` 只改未来会话的默认模型（以及可能的 `agent-default-model`）。完全退出并重开 DSH；当前会话用 `/model`。 |
| DSH 里没有 Go 模型 | 跑 `setup` 时还没有密钥。配置密钥、重启桥、重跑 `node bin.mjs setup`，再重启 DSH——或用 `--go-register`。 |
| 仪表盘乱码 | 使用 UTF-8 终端；`start.cmd` 会把 Windows 控制台切到 UTF-8。输出被重定向到管道时日志仍可用。 |

## 项目结构

```text
opencode-dsh-bridge/
├── bin.mjs                  # CLI：start / setup / key / stats / quota / doctor
├── lib/
│   ├── server.mjs           # HTTP 服务、路由、切档、Go 探测
│   ├── store.mjs            # 数据目录、状态、密钥、用量账本
│   ├── dashboard.mjs        # TUI、快捷键、密钥输入、实时面板
│   ├── panels.mjs           # 每日账单 / 总览 / 额度 / 帮助面板
│   ├── goQuota.mjs          # 官方 Go 价格、额度、峰时规则
│   ├── setup.mjs            # DSH profile 检测与 YAML 打补丁
│   ├── models.mjs, catalog.mjs, pricing.mjs  # 模型目录 + models.dev 查询
│   └── identity.mjs, ansi.mjs, ui.mjs, version.mjs  # 请求头、格式化、横幅
├── scripts/create-shortcut.ps1  # Windows 桌面快捷方式
├── start.cmd, start.sh, package.json, LICENSE
└── data/                        # 运行数据（已 gitignore，按需创建）
```

## 许可证与贡献

MIT，见 [LICENSE](LICENSE)。

欢迎贡献：保持零依赖；提 issue 前先跑 `node bin.mjs doctor`；永远不要提交 `data/` 或真实 API Key。附上桥版本和关键日志行最有帮助。
