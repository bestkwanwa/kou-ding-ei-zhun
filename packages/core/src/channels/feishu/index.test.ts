import { describe, it, expect, vi, afterEach } from "vitest";
import { createFeishuChannel, isChatAccepted, parseFeishuMessage, resolveFeishuConfig } from "./index.js";

// --- helpers ---

const VALID_APP_ID = "cli_0123456789abcdef";

function makeEvent(overrides?: {
  message?: Record<string, unknown>;
  sender?: Record<string, unknown>;
}): unknown {
  return {
    sender: { sender_id: { open_id: "ou_sender123", ...overrides?.sender } },
    message: {
      message_id: "om_message1",
      chat_id: "oc_chat1",
      message_type: "text",
      content: JSON.stringify({ text: "hello agent" }),
      create_time: "1732233600", // 秒
      ...overrides?.message,
    },
  };
}

// --- resolveFeishuConfig ---

describe("resolveFeishuConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers explicit options over env", () => {
    vi.stubEnv("KDA_FEISHU_APP_ID", "env_id");
    vi.stubEnv("KDA_FEISHU_APP_SECRET", "env_secret");
    const res = resolveFeishuConfig({ appId: VALID_APP_ID, appSecret: "explicit" });
    expect(res).toEqual({ appId: VALID_APP_ID, appSecret: "explicit" });
  });

  it("falls back to env", () => {
    vi.stubEnv("KDA_FEISHU_APP_ID", VALID_APP_ID);
    vi.stubEnv("KDA_FEISHU_APP_SECRET", "env_secret");
    expect(resolveFeishuConfig()).toEqual({ appId: VALID_APP_ID, appSecret: "env_secret" });
  });

  it("errors naming both env vars when config is missing", () => {
    vi.stubEnv("KDA_FEISHU_APP_ID", "");
    vi.stubEnv("KDA_FEISHU_APP_SECRET", "");
    const res = resolveFeishuConfig();
    expect("error" in res && res.error).toContain("KDA_FEISHU_APP_ID");
    expect("error" in res && res.error).toContain("KDA_FEISHU_APP_SECRET");
  });

  it("rejects malformed appId (SDK would silently not connect)", () => {
    const res = resolveFeishuConfig({ appId: "not-a-cli-id", appSecret: "s" });
    expect("error" in res && res.error).toContain("cli_");
  });
});

// --- parseFeishuMessage ---

describe("parseFeishuMessage", () => {
  it("maps a text message to InboundMessage + chatId", () => {
    const parsed = parseFeishuMessage(makeEvent());
    expect(parsed).toEqual({
      msg: {
        id: "om_message1",
        channel: "feishu",
        sender: "ou_sender123",
        text: "hello agent",
        timestamp: "2024-11-22T00:00:00.000Z",
      },
      chatId: "oc_chat1",
    });
  });

  it("returns null for non-text message types (image/post/...)", () => {
    expect(parseFeishuMessage(makeEvent({ message: { message_type: "image" } }))).toBeNull();
  });

  it("strips group @-mention placeholders via mentions[].key", () => {
    const parsed = parseFeishuMessage(
      makeEvent({
        message: {
          content: JSON.stringify({ text: "@_user_1 帮我看看这个 repo" }),
          mentions: [{ key: "@_user_1", name: "kda" }],
        },
      }),
    );
    expect(parsed?.msg.text).toBe("帮我看看这个 repo");
  });

  it("returns null for mention-only messages and bad JSON", () => {
    expect(
      parseFeishuMessage(
        makeEvent({ message: { content: JSON.stringify({ text: "@_user_1 " }), mentions: [{ key: "@_user_1" }] } }),
      ),
    ).toBeNull();
    expect(parseFeishuMessage(makeEvent({ message: { content: "not json" } }))).toBeNull();
  });

  it("normalizes seconds and milliseconds create_time to the same ISO", () => {
    const fromSeconds = parseFeishuMessage(makeEvent({ message: { create_time: "1732233600" } }));
    const fromMs = parseFeishuMessage(makeEvent({ message: { create_time: "1732233600000" } }));
    expect(fromSeconds?.msg.timestamp).toBe("2024-11-22T00:00:00.000Z");
    expect(fromMs?.msg.timestamp).toBe(fromSeconds?.msg.timestamp);
  });

  it("truncates over-long text to the shared limit", () => {
    const parsed = parseFeishuMessage(
      makeEvent({ message: { content: JSON.stringify({ text: "x".repeat(5000) }) } }),
    );
    expect(parsed?.msg.text).toHaveLength(4000);
  });
});

// --- chat 策略 ---

describe("isChatAccepted", () => {
  it("whitelist mode: only listed chats pass", () => {
    const allowed = new Set(["oc_a"]);
    expect(isChatAccepted("oc_a", allowed, null)).toBe(true);
    expect(isChatAccepted("oc_b", allowed, "oc_a")).toBe(false);
  });

  it("first-chat binding mode when whitelist unset", () => {
    const allowed = new Set<string>();
    expect(isChatAccepted("oc_first", allowed, null)).toBe(true); // 未绑定 → 接受（调用方随后绑定）
    expect(isChatAccepted("oc_first", allowed, "oc_first")).toBe(true); // 已绑定同 chat
    expect(isChatAccepted("oc_other", allowed, "oc_first")).toBe(false); // 其他 chat 拒绝
  });
});

// --- channel 基线（无网络：错误路径同步触发，SDK 不会被动态 import） ---

describe("createFeishuChannel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts stopped and surfaces sync config errors without throwing", () => {
    vi.stubEnv("KDA_FEISHU_APP_ID", "");
    vi.stubEnv("KDA_FEISHU_APP_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = createFeishuChannel();

    expect(channel.status()).toMatchObject({ name: "feishu", status: "stopped" });
    expect(() => channel.start(() => {})).not.toThrow();
    expect(channel.status()).toMatchObject({ status: "error" });
    expect(channel.status().detail).toContain("KDA_FEISHU_APP_ID");
    expect(warn).toHaveBeenCalled();
  });

  it("stop is idempotent and returns to stopped", async () => {
    vi.stubEnv("KDA_FEISHU_APP_ID", "");
    vi.stubEnv("KDA_FEISHU_APP_SECRET", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = createFeishuChannel();
    channel.start(() => {});
    await channel.stop();
    expect(channel.status()).toMatchObject({ status: "stopped", detail: undefined });
    await expect(channel.stop()).resolves.toBeUndefined();
  });

  it("send never rejects without a started client", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = createFeishuChannel();
    await expect(
      channel.send({ channel: "feishu", text: "x", timestamp: "t", replyTo: "om_1" }),
    ).resolves.toBeUndefined();
  });
});
