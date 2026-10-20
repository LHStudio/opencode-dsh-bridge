import { createDashboard } from "./dashboard.mjs";
import { clock, cyan, dim, gray } from "./ansi.mjs";

export * from "./ansi.mjs";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const status = {
  owner: null,
  render: null,
  frame: 0,
  timer: null,
  lastRender: 0,
};

let dashboard = null;

export function enableDashboard(cfg, meta = {}, options = {}) {
  if (dashboard) return true;
  if (cfg.quiet || process.env.BRIDGE_PLAIN) return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  try {
    dashboard = createDashboard(cfg, meta, options);
    return true;
  } catch {
    dashboard = null;
    return false;
  }
}

export function updateDashboardMeta(meta) {
  dashboard?.setMeta(meta);
}

export function recordRequest(info) {
  dashboard?.recordRequest(info);
}

export function stopDashboard() {
  if (!dashboard) return;
  dashboard.stop();
  dashboard = null;
}

function renderStatus(force = false) {
  if (!status.owner || !status.render) return;
  const now = Date.now();
  if (!force && now - status.lastRender < 100) return;
  status.lastRender = now;
  const icon = cyan(SPINNER[status.frame % SPINNER.length]);
  process.stdout.write(`\r\x1b[2K${icon} ${status.render()}`);
}

function clearStatusLine() {
  if (status.owner) process.stdout.write("\r\x1b[2K");
}

function stopTimer() {
  if (status.timer) clearInterval(status.timer);
  status.timer = null;
}

export function stopStatus() {
  if (dashboard) {
    dashboard.clearActive();
    return;
  }
  if (!status.owner) return;
  stopTimer();
  process.stdout.write("\r\x1b[2K");
  status.owner = null;
}

export function line(cfg, text) {
  if (cfg.quiet) return;
  const stamped = `${dim(clock())} ${text}`;
  if (dashboard) {
    dashboard.addLog(stamped);
    return;
  }
  clearStatusLine();
  console.log(stamped);
}

export function createStatus(cfg) {
  if (cfg.quiet) {
    return { update() {}, finish() {}, cancel() {} };
  }

  if (dashboard) {
    const active = dashboard.createStatus();
    let done = false;
    return {
      update(text) {
        if (done) return;
        active.update(text);
      },
      finish(text) {
        if (done) return;
        done = true;
        active.finish();
        if (text) line(cfg, text);
      },
      cancel(text) {
        if (done) return;
        done = true;
        active.finish();
        if (text) line(cfg, text);
      },
    };
  }

  if (!process.stdout.isTTY) {
    const print = (text) => {
      if (text) console.log(`${dim(clock())} ${text}`);
    };
    return { update() {}, finish: print, cancel: print };
  }

  const token = Symbol("status");
  let getText = () => "";
  let done = false;

  const takeOver = () => {
    stopTimer();
    status.owner = token;
    status.render = () => getText();
    status.frame = 0;
    status.lastRender = 0;
    status.timer = setInterval(() => {
      if (status.owner !== token) return;
      status.frame += 1;
      renderStatus(true);
    }, 120);
    status.timer.unref?.();
  };

  takeOver();

  const finish = (text) => {
    if (done) return;
    done = true;
    if (status.owner === token) {
      stopTimer();
      process.stdout.write("\r\x1b[2K");
      status.owner = null;
    }
    if (text) console.log(`${dim(clock())} ${text}`);
  };

  return {
    update(text) {
      if (done) return;
      getText = typeof text === "function" ? text : () => String(text);
      if (status.owner !== token) {
        takeOver();
        renderStatus(true);
        return;
      }
      status.render = () => getText();
      renderStatus();
    },
    finish,
    cancel: finish,
  };
}

export function banner(lines) {
  console.log("");
  for (const [index, text] of lines.entries()) {
    console.log(index === 0 ? text : `   ${text}`);
  }
  console.log("");
}

export function kv(label, value) {
  return `${gray(label.padEnd(8))} ${value}`;
}
