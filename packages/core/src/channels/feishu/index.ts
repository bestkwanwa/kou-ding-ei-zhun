import type * as lark from "@larksuiteoapi/node-sdk";
import type { Channel, ChannelInfo, InboundMessage, OutboundMessage } from "../types.js";
import { MAX_INBOUND_TEXT_CHARS } from "../web/index.js";

/**
 * 飞书 channel：实现 Channel 契约，把 agent 变成飞书 bot。
 * 长连接模式（WSClient）——无需公网 IP/域名，本进程即可收事件。
 * SDK 惰性加载：仅 start() 时动态 import，不用飞书的用户零成本。
 *
 * 契约约定（同 web channel）：start() 同步发起、永不抛错，异步结果落 status()；
 * stop()/send() 不抛错、幂等；send() 是唯一出站路径。
 */

const DESCRIPTION = "Feishu bot via long connection";
/** appId 格式 cli_ + 16 位十六进制；非法时 SDK 只打日志静默不连，必须预校验 */
const FEISHU_APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;
const MAX_REMEMBERED_CHATS = 256;
const MAX_SEEN_MESSAGES = 200;

export interface FeishuChannelOptions {
  /** 缺省取 KDA_FEISHU_APP_ID */
  appId?: string;
  /** 缺省取 KDA_FEISHU_APP_SECRET */
  appSecret?: string;
  /** 会话白名单；缺省取 KDA_FEISHU_CHAT_ID（逗号分隔），再缺省 = 首 chat 绑定 */
  allowedChatIds?: string[];
}

export type FeishuConfigResult = { appId: string; appSecret: string } | { error: string };

/** 解析配置（纯函数，单测对象）：options 优先，env 兜底 */
export function resolveFeishuConfig(options?: FeishuChannelOptions): FeishuConfigResult {
  const appId = options?.appId ?? process.env.KDA_FEISHU_APP_ID;
  const appSecret = options?.appSecret ?? process.env.KDA_FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    return { error: "missing KDA_FEISHU_APP_ID / KDA_FEISHU_APP_SECRET (set them in .env)" };
  }
  if (!FEISHU_APP_ID_RE.test(appId)) {
    return { error: "invalid KDA_FEISHU_APP_ID (expected cli_ + 16 hex digits)" };
  }
  return { appId, appSecret };
}

// ---------------------------------------------------------------------------
// 事件载荷解析（纯函数，单测对象；逐层收窄，不依赖 SDK 类型细节）
// ---------------------------------------------------------------------------

export interface ParsedFeishuMessage {
  msg: InboundMessage;
  chatId: string;
}

/** im.message.receive_v1 载荷 → InboundMessage；非文本/空文本/坏载荷 → null */
export function parseFeishuMessage(data: unknown): ParsedFeishuMessage | null {
  const d = asRecord(data);
  const message = asRecord(d?.message);
  const senderId = asRecord(asRecord(d?.sender)?.sender_id);
  if (!message || typeof message.message_id !== "string" || typeof message.chat_id !== "string") return null;
  // 收消息的字段是 message_type（msg_type 只在发送侧）
  if (message.message_type !== "text") return null;

  let text: string;
  try {
    const content = JSON.parse(typeof message.content === "string" ? message.content : "");
    text = typeof asRecord(content)?.text === "string" ? (content as { text: string }).text : "";
  } catch {
    return null;
  }

  // 群消息 @ 占位符：按 mentions[].key（如 "@_user_1"）从文本中剥离
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  for (const m of mentions) {
    const key = asRecord(m)?.key;
    if (typeof key === "string" && key) text = text.replaceAll(key, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > MAX_INBOUND_TEXT_CHARS) text = text.slice(0, MAX_INBOUND_TEXT_CHARS);

  return {
    msg: {
      id: message.message_id,
      channel: "feishu",
      sender: typeof senderId?.open_id === "string" ? senderId.open_id : "unknown",
      text,
      timestamp: toIsoTimestamp(message.create_time),
    },
    chatId: message.chat_id,
  };
}

/**
 * 单 chat 策略（纯函数，单测对象）：白名单配置了 → 只认白名单；
 * 未配置 → 首 chat 绑定（调用方在通过后自行落绑定）。
 */
export function isChatAccepted(chatId: string, allowed: ReadonlySet<string>, boundChatId: string | null): boolean {
  if (allowed.size > 0) return allowed.has(chatId);
  return boundChatId === null || boundChatId === chatId;
}

/** create_time 秒/毫秒歧义启发式；无效则用当前时间 */
function toIsoTimestamp(v: unknown): string {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 有界去重 Set（飞书是 at-least-once 推送，重推去重；超限丢最旧） */
function rememberSeen(set: Set<string>, id: string): boolean {
  if (set.has(id)) return false;
  set.add(id);
  if (set.size > MAX_SEEN_MESSAGES) set.delete(set.values().next().value as string);
  return true;
}

/** 有界 message_id → chat_id 映射（send 回程路由用；超限丢最旧） */
function rememberChat(map: Map<string, string>, messageId: string, chatId: string): void {
  if (map.has(messageId)) map.delete(messageId);
  map.set(messageId, chatId);
  if (map.size > MAX_REMEMBERED_CHATS) map.delete(map.keys().next().value as string);
}

// ---------------------------------------------------------------------------
// Channel 实现
// ---------------------------------------------------------------------------

export function createFeishuChannel(options?: FeishuChannelOptions): Channel {
  let info: ChannelInfo = { name: "feishu", description: DESCRIPTION, status: "stopped" };
  let sink: ((msg: InboundMessage) => void) | null = null;
  let client: lark.Client | null = null;
  let ws: lark.WSClient | null = null;
  let allowedChatIds: ReadonlySet<string>;
  let boundChatId: string | null = null;
  let generation = 0;
  const chatByMessage = new Map<string, string>();
  const seenMessageIds = new Set<string>();

  /** 发送：优先 reply（话题式回复，replyTo=message_id）；失败 fallback create 到 chat_id。
   *  飞书业务失败是 resolve 不是 reject（{code,msg}），成功判定必须查 code===0。 */
  async function sendRaw(replyToMessageId: string | null, chatId: string, text: string): Promise<void> {
    if (!client) return;
    const data = { msg_type: "text" as const, content: JSON.stringify({ text }) };
    if (replyToMessageId) {
      try {
        const res = await client.im.message.reply({ path: { message_id: replyToMessageId }, data });
        if (res.code === 0) return;
        console.warn(`[feishu] reply failed (${res.code} ${res.msg ?? ""}), falling back to create`);
      } catch (err) {
        console.warn(`[feishu] reply error: ${errorMessage(err)}, falling back to create`);
      }
    }
    try {
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, ...data },
      });
      if (res.code !== 0) console.warn(`[feishu] send failed: ${res.code} ${res.msg ?? ""}`);
    } catch (err) {
      console.warn(`[feishu] send error: ${errorMessage(err)}`);
    }
  }

  /** 飞书 3 秒规则：事件处理器必须 3s 内返回，否则飞书重推。此处只做同步解析 + 入队，
   *  绝不 await agent 回合（sink 仅推入 agent 的输入 FIFO，同步返回）。 */
  function handleReceive(data: unknown): void {
    try {
      const parsed = parseFeishuMessage(data);
      if (!parsed) return; // 非文本/空文本/坏载荷：静默丢弃
      if (!rememberSeen(seenMessageIds, parsed.msg.id)) return; // 重推去重
      if (!isChatAccepted(parsed.chatId, allowedChatIds, boundChatId)) {
        // 单 chat 策略：白名单外/未绑定的会话回罐头提示（附 chat_id 便于自助配置），不入 agent 队列
        void sendRaw(
          parsed.msg.id,
          parsed.chatId,
          `This bot is bound to another chat. Your chat_id: ${parsed.chatId} (set KDA_FEISHU_CHAT_ID to allow it).`,
        );
        return;
      }
      if (allowedChatIds.size === 0 && boundChatId === null) boundChatId = parsed.chatId;
      rememberChat(chatByMessage, parsed.msg.id, parsed.chatId);
      sink?.(parsed.msg);
    } catch (err) {
      console.warn(`[feishu] inbound error: ${errorMessage(err)}`);
    }
  }

  return {
    name: "feishu",
    description: DESCRIPTION,

    start(onMessage: (msg: InboundMessage) => void): void {
      if (info.status === "running" || info.status === "starting") return;
      allowedChatIds = new Set(options?.allowedChatIds ?? parseChatIdEnv());
      boundChatId = null;

      // 配置错误同步落 error（不抛）——/channel 命令能立即呈现
      const config = resolveFeishuConfig(options);
      if ("error" in config) {
        info = { ...info, status: "error", detail: config.error };
        console.warn(`Channel "feishu" failed: ${config.error}`);
        return;
      }

      sink = onMessage;
      info = { ...info, status: "starting", detail: "connecting (long connection)…" };
      const gen = ++generation;

      // SDK 惰性加载：仅真正启动时 import；全部失败路径落 status，绝不抛
      void (async () => {
        try {
          const sdk = await import("@larksuiteoapi/node-sdk");
          if (gen !== generation) return; // stop()/重启已使本次启动失效
          client = new sdk.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            loggerLevel: sdk.LoggerLevel.warn,
          });
          ws = new sdk.WSClient({
            appId: config.appId,
            appSecret: config.appSecret,
            loggerLevel: sdk.LoggerLevel.warn,
            // ws.start() 立即 resolve（内部 reConnect 异步）；真正的生命周期信号是这两个回调：
            onReady: () => {
              if (gen !== generation || info.status !== "starting") return;
              info = { ...info, status: "running", detail: "long connection ready" };
            },
            onError: (err: unknown) => {
              if (gen !== generation) return;
              const msg = errorMessage(err);
              info = { ...info, status: "error", detail: msg };
              console.warn(`Channel "feishu" failed: ${msg}`);
            },
          });
          await ws.start({
            eventDispatcher: new sdk.EventDispatcher({}).register({
              "im.message.receive_v1": handleReceive,
            }),
          });
        } catch (err) {
          if (gen !== generation) return;
          const msg = errorMessage(err);
          info = { ...info, status: "error", detail: msg };
          console.warn(`Channel "feishu" failed: ${msg}`);
        }
      })();
    },

    async stop(): Promise<void> {
      if (info.status === "stopped") return;
      generation++; // 使在途的动态 import 启动失效（close 一个还不存在的 ws）
      try {
        ws?.close({ force: true }); // 同步、释放 ws/定时器句柄，进程才能退出
      } catch {
        // best effort
      }
      ws = null;
      client = null;
      sink = null;
      chatByMessage.clear();
      seenMessageIds.clear();
      boundChatId = null;
      info = { ...info, status: "stopped", detail: undefined };
    },

    async send(out: OutboundMessage): Promise<void> {
      const chatId = out.replyTo ? chatByMessage.get(out.replyTo) : undefined;
      if (!client || !chatId) {
        console.warn(`[feishu] send dropped (no client or no chat for ${out.replyTo ?? "(no replyTo)"})`);
        return;
      }
      await sendRaw(out.replyTo ?? null, chatId, out.text);
    },

    status(): ChannelInfo {
      return { ...info };
    },
  };
}

function parseChatIdEnv(): string[] {
  const raw = process.env.KDA_FEISHU_CHAT_ID;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
