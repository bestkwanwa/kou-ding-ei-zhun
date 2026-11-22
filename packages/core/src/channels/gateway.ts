import type { Channel, ChannelInfo, InboundMessage, OutboundMessage } from "./types.js";
import { createLogger } from "../utils/logger.js";

/**
 * Channel 网关：渠道注册表 + 入站/出站路由。
 * 入站：渠道消息经 setOnInbound 注入的 sink 进入 agent 统一输入队列（agent/input.ts）；
 * 出站：reply() 是唯一回复路径，经对应渠道的 send() 送达，内部隔离错误、永不 reject。
 */
export class ChannelGateway {
  private channels = new Map<string, Channel>();
  private onInbound: ((msg: InboundMessage) => void) | null = null;
  private log;

  constructor(cwd: string) {
    this.log = createLogger(cwd);
  }

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  list(): ChannelInfo[] {
    return [...this.channels.values()].map((c) => c.status());
  }

  /**
   * 发起启动（fire-and-forget：/channel 的 execute 是同步的）。
   * 返回 undefined = 已发起；返回字符串 = 错误信息。
   */
  start(name: string): string | undefined {
    const channel = this.channels.get(name);
    if (!channel) {
      return `Channel "${name}" not found.` + this.existingHint();
    }
    const current = channel.status().status;
    if (current === "running" || current === "starting") {
      return `Channel "${name}" is already ${current}.`;
    }
    channel.start((msg) => this.deliverInbound(msg));
    this.log.log(`[channel] start: ${name}`);
    return undefined;
  }

  /** 发起停止（channel.stop() 按约定不抛错）；返回 undefined = 已发出；返回字符串 = 错误信息 */
  stop(name: string): string | undefined {
    const channel = this.channels.get(name);
    if (!channel) {
      return `Channel "${name}" not found.` + this.existingHint();
    }
    if (channel.status().status === "stopped") {
      return `Channel "${name}" is not running.`;
    }
    void channel.stop().catch(() => {}); // 幂等 + 错误已由 channel 落 status
    this.log.log(`[channel] stop: ${name}`);
    return undefined;
  }

  /** 停止全部渠道；run.ts 的 finally 必须调用（open http server 会挂住事件循环） */
  async stopAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        this.log.log(`[channel] stopped: ${name}`);
      } catch (err) {
        console.warn(`Failed to stop channel "${name}": ${errorMessage(err)}`);
      }
    }
  }

  /** 注入入站 sink（agent 的输入多路复用器启动时接线） */
  setOnInbound(cb: (msg: InboundMessage) => void): void {
    this.onInbound = cb;
  }

  /** 回复入站消息：唯一回复路径，经 channel.send 送达；内部隔离错误，永不 reject */
  async reply(text: string, replyTo: InboundMessage): Promise<void> {
    const channel = this.channels.get(replyTo.channel);
    if (!channel) {
      this.log.log(`[channel] reply dropped: channel "${replyTo.channel}" not found`);
      return;
    }
    const out: OutboundMessage = {
      channel: replyTo.channel,
      text,
      timestamp: new Date().toISOString(),
      replyTo: replyTo.id,
    };
    try {
      await channel.send(out);
    } catch (err) {
      console.warn(`Failed to send reply via channel "${replyTo.channel}": ${errorMessage(err)}`);
      this.log.log(`[channel] reply error: ${errorMessage(err)}`);
    }
  }

  private deliverInbound(msg: InboundMessage): void {
    this.log.log(`[channel] inbound:`, msg);
    if (this.onInbound) {
      this.onInbound(msg);
    } else {
      // 正常不可达：渠道只能经 /channel 启动，而输入层先于任何命令接线 sink
      console.warn(`Channel message dropped (no consumer): ${msg.text.slice(0, 80)}`);
    }
  }

  private existingHint(): string {
    const names = [...this.channels.keys()];
    return names.length > 0 ? ` Existing: ${names.join(", ")}.` : " (no channels registered)";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
