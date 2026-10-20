const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(code) {
  return (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
}

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");
export const gray = wrap("90");

export const ICONS = {
  bridge: "🌉",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  arrow: "➜",
  sync: "🔄",
  bolt: "⚡",
  dot: "·",
  cancel: "⊘",
};

export function clock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function clockTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 100) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n >= 0.0001) return `$${n.toFixed(5)}`;
  if (n >= 0.000001) return `$${n.toFixed(6)}`;
  return "<$0.000001";
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_AT_START = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

function charWidth(codePoint) {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200d
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(text) {
  const source = String(text);
  let width = 0;
  for (let i = 0; i < source.length; ) {
    if (source[i] === "\x1b") {
      const match = ANSI_AT_START.exec(source.slice(i));
      if (match) {
        i += match[0].length;
        continue;
      }
    }
    const codePoint = source.codePointAt(i);
    const char = String.fromCodePoint(codePoint);
    width += charWidth(codePoint);
    i += char.length;
  }
  return width;
}

export function truncateAnsi(text, maxWidth) {
  const source = String(text);
  if (maxWidth <= 0) return "";
  if (visibleWidth(source) <= maxWidth) return source;
  let out = "";
  let width = 0;
  for (let i = 0; i < source.length; ) {
    if (source[i] === "\x1b") {
      const match = ANSI_AT_START.exec(source.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const codePoint = source.codePointAt(i);
    const char = String.fromCodePoint(codePoint);
    const charColumns = charWidth(codePoint);
    if (width + charColumns > maxWidth) break;
    out += char;
    width += charColumns;
    i += char.length;
  }
  return out + "\x1b[0m";
}
