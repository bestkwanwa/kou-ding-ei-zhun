import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { InboundMessage } from "../channels/types.js";
import {
  CRON_SOURCE,
  DEFAULT_CHANNEL_ROLE,
  DEFAULT_CRON_ROLE,
  SECURITY_STATE_FILENAME,
  TERMINAL_ROLE,
  TERMINAL_SOURCE,
  type Actor,
  type Role,
  type SecurityState,
  isRole,
} from "./types.js";

/**
 * 角色管理器：当前发言者（actor）跟踪 + 渠道角色持久化。
 * terminal 恒为 owner（硬编码）；渠道角色按渠道名解析（绝不按 sender——web 的 sender 客户端可任意填），
 * 缺省 guest，配置落 <cwd>/.kda/security.json（读写遵循 plugins.json 模式：ENOENT 静默默认、损坏默认 + 单次警告）。
 */
export class RoleManager {
  private readonly statePath: string;
  private readonly cwd: string;
  private currentActor: Actor;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.statePath = resolve(cwd, ".kda", SECURITY_STATE_FILENAME);
    // 默认 terminal owner：覆盖 initialPrompt 在任何输入事件之前执行的轮次
    this.currentActor = { role: TERMINAL_ROLE, source: TERMINAL_SOURCE };
  }

  /** 当前发言者（最后一次输入事件设定；进程启动至首个事件前 = terminal owner） */
  get current(): Actor {
    return this.currentActor;
  }

  /** terminal 输入事件到达时调用（须在 dispatcher.dispatch 之前，命令才能拿到正确 actor） */
  setTerminalActor(): void {
    this.currentActor = { role: TERMINAL_ROLE, source: TERMINAL_SOURCE };
  }

  /** 渠道输入事件到达时调用（同上）；角色按 msg.channel 查配置 */
  setChannelActor(msg: InboundMessage): void {
    this.currentActor = {
      role: this.getChannelRole(msg.channel),
      source: msg.channel,
      sender: msg.sender,
    };
  }

  /** cron 到点事件到达时调用（同上）；"cron" 伪渠道查配置，缺省 collaborator（无人值守受限） */
  setCronActor(taskId: string): void {
    this.currentActor = {
      role: this.readState().channelRoles[CRON_SOURCE] ?? DEFAULT_CRON_ROLE,
      source: CRON_SOURCE,
      sender: taskId,
    };
  }

  /** 渠道角色；未配置 = guest */
  getChannelRole(name: string): Role {
    return this.readState().channelRoles[name] ?? DEFAULT_CHANNEL_ROLE;
  }

  /** 持久化渠道角色（owner-only 强制在 /security 命令层，这里只管写入） */
  setChannelRole(name: string, role: Role): "ok" | "io-error" {
    const state = this.readState();
    state.channelRoles[name] = role;
    return this.writeState(state);
  }

  /** 已配置渠道角色快照（/security status 用） */
  listChannelRoles(): Record<string, Role> {
    return { ...this.readState().channelRoles };
  }

  // --- 内部实现 ---

  /** 读状态；ENOENT = 默认（静默）；其他读错误 / 损坏 JSON = 默认 + 单次警告 */
  private readState(): SecurityState {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { channelRoles: {} };
      console.warn(chalk.yellow(`[security] could not read ${SECURITY_STATE_FILENAME}, using default channel roles`));
      return { channelRoles: {} };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { channelRoles?: unknown }).channelRoles === "object") {
        const roles = (parsed as { channelRoles: Record<string, unknown> }).channelRoles;
        const valid: Record<string, Role> = {};
        for (const [name, role] of Object.entries(roles)) {
          if (isRole(role)) valid[name] = role;
        }
        return { channelRoles: valid };
      }
    } catch {
      // JSON 语法错误，落到下方统一警告
    }
    console.warn(chalk.yellow(`[security] invalid ${SECURITY_STATE_FILENAME}, using default channel roles`));
    return { channelRoles: {} };
  }

  private writeState(state: SecurityState): "ok" | "io-error" {
    try {
      mkdirSync(resolve(this.cwd, ".kda"), { recursive: true });
      const sorted = Object.fromEntries(Object.entries(state.channelRoles).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(this.statePath, `${JSON.stringify({ channelRoles: sorted }, null, 2)}\n`, "utf-8");
      return "ok";
    } catch {
      return "io-error";
    }
  }
}
