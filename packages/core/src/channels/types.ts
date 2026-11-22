/** 渠道入站消息（外部世界 → agent） */
export interface InboundMessage {
  /** 唯一 id，回复时作为 replyTo 回传 */
  id: string;
  /** 来源渠道名（= channel.name） */
  channel: string;
  /** 展示用发送者名 */
  sender: string;
  /** 消息正文（已 trim，非空） */
  text: string;
  /** ISO 时间戳 */
  timestamp: string;
}

/** 渠道出站消息（agent → 外部世界；经 channel.send 送达） */
export interface OutboundMessage {
  channel: string;
  text: string;
  timestamp: string;
  /** 回复对象的入站 id；主动发送时省略（v1 未用，接口预留） */
  replyTo?: string;
}

export type ChannelStatus = "stopped" | "starting" | "running" | "error";

/** /channel list 展示的单条渠道信息 */
export interface ChannelInfo {
  name: string;
  description: string;
  status: ChannelStatus;
  /** 附加信息：running/starting 时为 URL，error 时为错误摘要 */
  detail?: string;
}

/**
 * 渠道：agent 与外部世界的双向通道。实现约定：
 * - start() 同步发起、永不抛错；异步监听结果（含 EADDRINUSE）落到 status()；
 * - stop()/send() 不抛错、幂等；
 * - send() 是唯一出站路径（回复与将来的主动发送都走它）。
 */
export interface Channel {
  readonly name: string;
  readonly description: string;
  /** 启动并绑定资源；onMessage 为入站 sink（由 gateway 在 start 时注入） */
  start(onMessage: (msg: InboundMessage) => void): void;
  /** 停止并释放资源（关 server / 断开连接），幂等 */
  stop(): Promise<void>;
  /** 送达一条出站消息 */
  send(out: OutboundMessage): Promise<void>;
  /** 当前状态（供 /channel list 与测试） */
  status(): ChannelInfo;
}
