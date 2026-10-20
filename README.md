# opencode-dsh-bridge

A local, zero-dependency Node.js (>= 18.17) OpenAI-compatible bridge that exposes **OpenCode Zen free models** (`/v1`) and **OpenCode Go subscription models** (`/go/v1`) to **DeepSeek Harness (DSH)** as ordinary model providers.

The bridge listens on `127.0.0.1:8787`, speaks the OpenAI Chat Completions API (including streaming), and translates each request to the matching `opencode.ai` inference endpoint. DSH sees two providers — `opencode-free` and `opencode-go` — so you can pick free models for everyday work and switch to your Go subscription when you need the stronger ones. Everything runs on your machine: nothing leaves it except upstream requests to `opencode.ai` for model calls and listings, and a periodic read of the public `models.dev` pricing catalog.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by OpenCode or DeepSeek. It is a personal interoperability tool.
>
> **Estimates.** All dollar amounts in the dashboard, `stats`, `quota` and `/usage` are local estimates computed from your own request log. They are not bills, and they are not read from any official billing system.

## Features

- **Two channels, one process.** Free Zen models on `/v1`, Go models on `/go/v1`; each endpoint accepts only models from its own catalog.
- **Hotkey tier switching.** Press `Tab` in the TUI to flip the default tier between free and Go. In-session switching still uses DSH's own `/model` picker.
- **Automatic Go-key prompt.** Switching to Go without a credential opens an inline input; the key is validated before it is saved.
- **Persistent local ledger.** One record per model call in `data/usage.jsonl`; daily request counts, successes, failures, cancels, tokens, free-tier saved money and Go spend survive restarts.
- **TUI dashboard.** Live log view plus daily bill (`d`), Go quota (`q`), overview (`s`) and help (`?`/`h`) panels, with scrolling and a masked key prompt.
- **Local Go quota estimation.** Official per-model monthly limits, 5-hour/weekly/monthly windows, DeepSeek peak/off-peak pricing and long-context price tiers, computed from your ledger; `p` toggles Go ($10/mo) / Go Plus ($40/mo).
- **CLI tooling.** `stats`, `quota` and `doctor` with `--json` output for scripting.
- **Multi-profile DSH setup.** Detects `desktop` and `web` profiles, writes only its own marked block, and is idempotent.
- **Portable.** No absolute paths in the code; runtime data defaults to `<repo>/data` and can be moved with `--data-dir` or `BRIDGE_DATA_DIR`.

## Quick start

Requirements: [Node.js](https://nodejs.org/) >= 18.17 and a working DeepSeek Harness installation. No `npm install` is needed — the project has zero dependencies.

```shell
git clone https://github.com/<your-name>/opencode-dsh-bridge.git
cd opencode-dsh-bridge
# Start the bridge (keep this window open while using DSH):
start.cmd                        # Windows, or double-click it
chmod +x start.sh && ./start.sh  # macOS / Linux
node bin.mjs start               # any platform
```

Then register the bridge as a DSH model provider and restart DSH:

```shell
node bin.mjs setup      # writes ~/.dsh/profiles/<profile>/cordis.patch.yml
node bin.mjs doctor     # optional self-check: Node, data dir, profiles, port
```

Fully quit and reopen DSH, then choose a model from:

- **OpenCode Free (bridge)** — e.g. `deepseek-v4.1-flash-free`
- **OpenCode Go (bridge)** — e.g. `deepseek-v4.1-flash` (only present once a Go key is configured)

`node bin.mjs setup` can run before or after the bridge starts; when the bridge is down it falls back to the upstream model list and the bundled Go catalog.

## Windows desktop shortcut

`scripts/create-shortcut.ps1` creates a Desktop shortcut named “OpenCode 桥接器” that opens the bridge in a `cmd /k` window:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
# optional: -Destination "<folder>" -Name "My bridge"
```

The shortcut runs `start.cmd`, which keeps the console open on failure so you can read the error (it does not pause on a normal `Ctrl+C` exit). Closing the console window stops the bridge.

## Using OpenCode Go

Go models require an OpenCode Go subscription and an API key:

1. Subscribe to OpenCode Go at <https://opencode.ai/go> ($10/month Go, $40/month Go Plus).
2. Create an API key in the OpenCode console.
3. Give the key to the bridge in any of these ways:

```shell
# 1) Save it once; the bridge picks it up on every start.
node bin.mjs key set sk-...
node bin.mjs key set sk-... --verify   # validate first with a tiny Go request

# 2) Pass it at startup.
node bin.mjs start --go-key sk-...
# or: OPENCODE_GO_API_KEY=sk-... node bin.mjs start

# 3) Paste it into the TUI.
# Press k (or Tab while on the free tier); the key is validated, saved, and Go is enabled.
```

Keys are stored in `data/secrets.json` with mode `600` on POSIX systems, are never written to the ledger, and are always masked in the TUI and CLI (`sk-a…wxyz`). Command-line/environment values take precedence over the saved key. Restart the bridge after `key set`; `data/` is gitignored, so a saved key is never committed.

## Switching tiers

There are two different switches — use the right one:

| Action | Where | Effect |
| --- | --- | --- |
| `Tab` | Bridge TUI | Flips the bridge's default tier (`free` ↔ `go`). Unless disabled, it also rewrites DSH's `agent-default-model` to that tier's default model. **Restart DSH** for the new default to apply. |
| `/model` | Inside DSH | Switches the model for the current session immediately; no restart, no file changes. |

The bridge never remaps model ids between channels: a free model is only served on `/v1`, a Go model only on `/go/v1`. The running tier is restored from `data/state.json` (Go only when a credential is present); `Tab` or `POST /tier` changes it, and `--no-auto-default` keeps `Tab` from rewriting the DSH default model.

## TUI hotkeys

| Key | Action |
| --- | --- |
| `Tab` | Switch the default tier (`free` ↔ `go`); prompts for a Go key when none is saved |
| `d` | Daily bill: requests, successes, failures, cancels, tokens, saved value, Go spend |
| `q` | Go quota panel (per-model 5 h / weekly / monthly remaining) |
| `s` | Overview: today + all-time totals, Go plan, upstream URLs, data directory |
| `p` | Toggle Go / Go Plus (inside the quota panel only) |
| `k` | Set or paste the Go key (works from any view) |
| `?` / `h` | Help |
| `Esc` | Back to the live log |
| `↑` / `↓` | Scroll one line |
| `PgUp` / `PgDn` | Scroll one page (the mouse wheel works too) |
| `c` | Clear the visible log — never the ledger |
| `Ctrl+C` | Quit |

The dashboard header summarises today's requests, tokens, spend and savings; every panel scrolls, the footer shows the visible range for overflowing panels, and the live log keeps filling in the background.

## CLI reference

Run `node bin.mjs help` (or `-h`) for the built-in help. Commands:

| Command | Description |
| --- | --- |
| `start` (default) | Start the bridge, dashboard and HTTP server. |
| `setup` | Register `opencode-free` (and `opencode-go` when a key/`--go-register` is present) in detected DSH profiles. |
| `key set\|show\|clear` | Save (optionally `--verify`), display masked, or delete the Go key in `data/secrets.json`. |
| `stats [--days N]` | Print the daily bill from the ledger (default 14 days, clamped to 1–120). |
| `quota [--plan go\|go-plus]` | Print estimated Go quota per model for the chosen plan. |
| `doctor` | Self-check Node version, data directory, ledger, Go key, DSH profiles and whether the bridge is running. |

Global flags (all commands):

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | `8787` (env `PORT`) | Bridge listen port. |
| `--go-key <key>` | env `OPENCODE_GO_API_KEY` | Go credential for this run; not persisted. |
| `--go-plan <plan>` | env `BRIDGE_GO_PLAN`, stored plan | `go` or `go-plus`; scales the quota table. |
| `--data-dir <dir>` | `<repo>/data` (env `BRIDGE_DATA_DIR`) | Where `state.json`, `secrets.json` and `usage.jsonl` live. |
| `--profile <names>` | auto-detect | Comma-separated DSH profiles to write during `setup`. |
| `--json` | off | Machine-readable output for `stats`, `quota`, `doctor`, `key show`. |
| `--no-sync` | off | Disable periodic model-list refresh (default every 600 s). |
| `--no-auto-default` | off | Do not rewrite DSH's `agent-default-model` when switching tiers. |
| `--go-register` | off | Register the Go provider even without a key; DSH then lists it, but Go requests return `400 go_credential_missing` until one is set. |
| `--quiet` | off | Suppress per-request log lines; warnings and the startup banner still print. |

Other real flags: `--host` (default `127.0.0.1`), `--tier free|go` (selects the tier written by `setup --set-default`; the running bridge restores the tier saved in `data/state.json`), `--set-default` (with `setup`), `--sync-interval <seconds>`, `--fallback`, `--allow-paid`, `--extra-free <ids>`, `--upstream`, `--models-url`, `--key`, `--ua`, `--client`, `--project`, `--go-upstream`, `--go-ua`, `--dsh-home`.

## DSH configuration

`node bin.mjs setup` writes to `~/.dsh/profiles/<profile>/cordis.patch.yml`. Profiles are DSH configuration directories, **not** the Windows Desktop folder: `desktop` is the DSH Desktop app profile and `web` is the DSH Web/CLI profile. Both are detected and written when present; pass `--profile desktop` (or a comma-separated list) to target specific ones.

The bridge owns a single marked block. Re-running `setup` removes the previous `opencode-*` provider definitions and marker line, then writes a fresh block, leaving every other entry untouched. Whenever `setup` changes a file, the original is copied to `<file>.bak-bridge-<timestamp>`. DSH reads this file at startup, so restart DSH after switching the default. An abridged sample:

```yaml
# Added by opencode-dsh-bridge：OpenCode Zen 免费模型 + OpenCode Go 订阅模型 经本地桥接入。
- id: llm-pi-ai
  config:
    providers:
      opencode-free: { displayName: OpenCode Free (bridge), api: openai-completions,
        baseURL: http://127.0.0.1:8787/v1, headers: { Authorization: Bearer public },
        models: [{ id: deepseek-v4.1-flash-free }] }  # full specs generated per model
      # opencode-go: same shape, baseURL http://127.0.0.1:8787/go/v1, e.g. deepseek-v4.1-flash
```

`--set-default` (and `Tab`, unless `--no-auto-default`) also rewrites the existing default-model entry:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-free        # opencode-go on the Go tier
    model: deepseek-v4.1-flash-free # deepseek-v4.1-flash on the Go tier
```

## HTTP API

Everything is OpenAI-compatible and bound to localhost only. CORS is enabled (`access-control-allow-origin: *`, methods `GET, POST, OPTIONS`) so browser-based clients can call it directly; streaming (`"stream": true`) is supported and passed through as SSE.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Status: tier, plan, both catalogs, pricing snapshot, credential flags. |
| `GET` | `/tier` | `{ tier, plan, goEnabled, goCredential }`. |
| `POST` | `/tier` | Body `{"tier":"free"\|"go"}`; switches tier and optionally rewrites the DSH default model. |
| `GET` | `/usage` | Daily rows, totals, all-time totals and estimated Go quota rows. |
| `GET` | `/v1/models` | Free-channel model list (`object: "list"`). |
| `POST` | `/v1/chat/completions` | Free-channel chat completions (streaming or JSON). |
| `GET` | `/go/v1/models` | Go-channel model list. |
| `POST` | `/go/v1/chat/completions` | Go-channel chat completions. |

Errors use the OpenAI error envelope. A model from the wrong channel returns `403 model_not_allowed` with a hint pointing at the correct endpoint; the Go endpoint returns `400 go_credential_missing` when no key is configured.

## Usage ledger and Go quota

Every model call — success, failure or cancel — appends one JSON line to `data/usage.jsonl`. The dashboard, `stats`, `quota` and `/usage` aggregate that file, so history survives restarts and data-directory moves. Records older than 400 days are pruned at startup.

Free-tier “saved” is the equivalent value of the tokens at published model prices from `models.dev` — money you did not spend. Go spend is token usage multiplied by the official Go price table.

**Go quota is a local estimate.** OpenCode exposes no public usage/quota API, so the bridge computes consumption from its own ledger using the published limits and prices from <https://opencode.ai/docs/go/>. Use it to notice that you are about to hit a limit; the official console and its rate limits remain authoritative. A request made through another client, or before this bridge was installed, is invisible here.

Official rules the estimate applies:

- Monthly dollar allowance per model, with `Go` and `Go Plus` columns (e.g. DeepSeek V4.1 Flash **$80 / $160**, GLM-5.3-Flash **$60 / $180**, Kimi K3 **$15 / $60**).
- Windows: 5 hours ≤ 20% of the monthly allowance, one week ≤ 50%, one month ≤ 100%.
- Some models are unlimited inside Go and are shown as such: `beam-free`, `longcat-2.5-preview-free`, `minimax-m3.1-flash-free`.
- DeepSeek V4.1 Flash / V4 Pro use peak pricing Monday–Friday **01:00–04:00** and **06:00–10:00 UTC**, off-peak otherwise; long-context models (Qwen3.7 Plus 256K, Grok 4.7 200K, GPT-6 Luna 272K, Claude Haiku 5.5 100K) switch to the higher tier by prompt + completion tokens.

## Data and privacy

| File | Contents |
| --- | --- |
| `data/state.json` | Selected tier and Go plan. |
| `data/secrets.json` | Go key, written with mode `600` where supported, masked everywhere it is displayed. |
| `data/usage.jsonl` | Append-only request ledger, one record per model call, pruned after 400 days. |

The data directory defaults to `<repo>/data`; use `--data-dir` or `BRIDGE_DATA_DIR` to put it elsewhere (a synced or backup folder works). `data/` is listed in `.gitignore` — keep it that way. No telemetry is collected, no analytics service is contacted, and keys are never logged. Deleting `data/usage.jsonl` resets the bill and quota estimate; deleting `data/state.json` resets the tier/plan selection.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` on start | Another bridge is already running on the port. Stop it, or start with `--port 8788` (then re-run `setup` so DSH points at the new port). |
| Go request returns `401` / `invalid credential` | The Go key is wrong, incomplete, or belongs to another account. Re-paste it (`node bin.mjs key set sk-... --verify`) and restart the bridge. |
| `GET /inference/go/openai/v1/models` returns `404` | Expected: the Go upstream has no model-list endpoint. The bridge serves its own `/go/v1/models` from the bundled/models.dev catalog. |
| `403 model_not_allowed` (or a `404` for an unknown path) when mixing tiers | Free models exist only on `/v1`, Go models only on `/go/v1`. Choose the matching provider in DSH, or switch tiers and pick again. |
| Quota numbers differ from the official console | The quota panel is a local estimate from this bridge's ledger, not official billing. Check the OpenCode console for authoritative usage. |
| DSH still shows old models, or `Tab` did nothing to the running chat | `Tab` only changes the default for future sessions (and may rewrite `agent-default-model`). Fully quit and reopen DSH, then use `/model` for the running session. |
| Go models missing from DSH | No key was configured when `setup` ran. Set the key, restart the bridge, re-run `node bin.mjs setup`, then restart DSH — or use `--go-register`. |
| Dashboard renders garbage | Use a UTF-8 terminal; `start.cmd` switches the Windows console to UTF-8. Logs still work in a plain pipe. |

## Project layout

```text
opencode-dsh-bridge/
├── bin.mjs                  # CLI: start / setup / key / stats / quota / doctor
├── lib/
│   ├── server.mjs           # HTTP server, routing, tier switching, Go probe
│   ├── store.mjs            # data dir, state, secrets, usage ledger
│   ├── dashboard.mjs        # TUI, hotkeys, key prompt, live panels
│   ├── panels.mjs           # daily bill / overview / quota / help panels
│   ├── goQuota.mjs          # official Go prices, limits, peak hours
│   ├── setup.mjs            # DSH profile detection and YAML patching
│   ├── models.mjs, catalog.mjs, pricing.mjs  # catalogs + models.dev lookup
│   └── identity.mjs, ansi.mjs, ui.mjs, version.mjs  # headers, formatting, banner
├── scripts/create-shortcut.ps1  # Windows Desktop shortcut
├── start.cmd, start.sh, package.json, LICENSE
└── data/                        # runtime data (gitignored, created on demand)
```

## License and contributing

MIT — see [LICENSE](LICENSE).

Contributions are welcome: keep the project dependency-free, run `node bin.mjs doctor` before opening an issue, and never commit `data/` or real API keys. Bug reports with the bridge version (the `--go-ua` default shown by `node bin.mjs help`) and the relevant log lines are the most useful.
