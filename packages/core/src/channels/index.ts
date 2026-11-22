export { ChannelGateway } from "./gateway.js";
export { createWebChannel, DEFAULT_WEB_CHANNEL_PORT, MAX_INBOUND_TEXT_CHARS } from "./web/index.js";
export type { WebChannelOptions } from "./web/index.js";
export type {
  Channel,
  ChannelInfo,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
} from "./types.js";

import { ChannelGateway } from "./gateway.js";
import { createWebChannel } from "./web/index.js";

/** 创建带内置渠道（当前仅 web）的 gateway —— CLI 在 runAgent 前创建，finally 中 stopAll */
export function createDefaultChannelGateway(cwd: string): ChannelGateway {
  const gateway = new ChannelGateway(cwd);
  gateway.register(createWebChannel());
  return gateway;
}
