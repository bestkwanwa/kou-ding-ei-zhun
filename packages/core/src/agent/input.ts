import * as readline from "node:readline";
import chalk from "chalk";
import type { ChannelGateway, InboundMessage } from "../channels/index.js";

/** 终端行与渠道消息统一为同一事件流（主循环单消费者，串行处理） */
export type AgentInputEvent =
  | { type: "terminal"; line: string }
  | { type: "channel"; message: InboundMessage };

export interface AgentInput {
  /** 显示提示符（每轮循环调用一次） */
  prompt(): void;
  /** 等待下一个事件；close 后恒返回空 terminal 事件（退出哨兵）；单消费者 */
  next(): Promise<AgentInputEvent>;
  close(): void;
}

/** 测试可注入流；缺省 process.stdin/stdout */
export interface AgentInputStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * 统一输入源：readline 永久监听 "line"（逐次 rl.question 无法与渠道消息竞争，
 * 且遗留的孤儿 question 回调会偷走下一行输入），渠道消息经 gateway.setOnInbound 接入同一 FIFO。
 * 相对旧实现的两个改进：LLM 回合中键入的行入队不丢；stdin EOF（close）→ 空 terminal
 * 事件走既有空行退出路径，管道 stdin 不再只处理首行。
 */
export function createAgentInput(gateway?: ChannelGateway, streams?: AgentInputStreams): AgentInput {
  const rl = readline.createInterface({
    input: streams?.input ?? process.stdin,
    output: streams?.output ?? process.stdout,
  });
  const queue: AgentInputEvent[] = [];
  let waiter: ((ev: AgentInputEvent) => void) | null = null;
  let closed = false;

  const push = (ev: AgentInputEvent) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(ev);
    } else {
      queue.push(ev);
    }
  };

  // 永久监听：回合进行中键入的行不再丢失（旧 rl.question 实现下会被丢弃）
  rl.on("line", (line) => push({ type: "terminal", line }));
  // EOF / 流关闭 → 空 terminal 事件 = 退出哨兵，杜绝挂死
  rl.on("close", () => {
    closed = true;
    push({ type: "terminal", line: "" });
  });

  gateway?.setOnInbound((message) => push({ type: "channel", message }));

  return {
    prompt() {
      if (closed) return;
      rl.setPrompt(chalk.cyan("> "));
      rl.prompt();
    },
    next() {
      const ev = queue.shift();
      if (ev) return Promise.resolve(ev);
      if (closed) return Promise.resolve({ type: "terminal", line: "" });
      if (waiter) throw new Error("AgentInput.next() called concurrently (single consumer)");
      return new Promise<AgentInputEvent>((resolve) => {
        waiter = resolve;
      });
    },
    close() {
      closed = true;
      rl.close();
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ type: "terminal", line: "" });
      }
    },
  };
}
