import { createHash, webcrypto } from "node:crypto";

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 26;

let lastTimestamp = 0;
let counter = 0;

export function makeId(descending = false, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const time = Array.from({ length: 6 }, (_, i) =>
    Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const bytes = webcrypto.getRandomValues(new Uint8Array(ID_LENGTH - 12));
  return time + Array.from(bytes, (byte) => CHARS[byte % 62]).join("");
}

export function sessionId() {
  return "ses_" + makeId(true);
}

export function requestId() {
  return "msg_" + makeId(false);
}

export function agentHeaders(cfg, session) {
  const id = session ?? sessionId();
  return {
    "user-agent": cfg.ua,
    "x-opencode-client": cfg.client,
    "x-opencode-project": cfg.project,
    "x-opencode-session": id,
    "x-opencode-session-id": id,
    "x-opencode-request": requestId(),
  };
}

/**
 * OpenCode Go 通道的身份头。
 *
 * Go 官方文档要求客户端用自己的 UA（而不是伪装成 OpenCode 或某个 SDK），
 * 并为每段对话带上稳定的 `x-opencode-session`，用于路由与 prompt 缓存。
 * 因此这里不再发送 Zen 免费层门禁所需的 `x-opencode-client/project/request`。
 */
export function goHeaders(cfg, session) {
  const id = session ?? sessionId();
  return {
    "user-agent": cfg.goUa || `opencode-dsh-bridge/${cfg.version || "0.1.0"}`,
    "x-opencode-session": id,
  };
}

/**
 * 从一段对话内容推导稳定会话 ID。
 *
 * dsh / pi-ai 默认不发送 session 头，而 Go 需要「同一段对话用同一个会话 ID」。
 * 这里用「模型 + 第一条非 system 消息」做指纹：同一段对话后续请求都带着同样的
 * 历史消息，因此指纹不变；不同对话几乎必然不同。客户端自己带了 `x-session-id`
 * 时优先使用客户端值。
 */
export function conversationSession(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = messages.find((message) => message?.role !== "system") ?? messages[0];
  const seed = JSON.stringify([body?.model ?? "", first?.role ?? "", first?.content ?? ""]);
  return "ses_" + createHash("sha256").update(seed).digest("hex").slice(0, 26);
}
