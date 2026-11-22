import type { Command, CommandContext } from "./types.js";

/** 纯分发结果（不打印）—— 终端与渠道消息共用同一分发语义 */
export type DispatchResult =
  /** 非 "/" 开头 → 交回 REPL 走 LLM，原文 */
  | { kind: "not-command" }
  /** 命令域已处理（output 待打印/回发，可为 "" = 静默成功） */
  | { kind: "handled"; output: string }
  /** /<skill-name> 快捷执行 → text 作为 user message 转发给 LLM；notice 为提示文本 */
  | { kind: "forward"; text: string; notice: string };

/**
 * 斜杠命令分发器："/" 前缀输入在进入 LLM 前被拦截。
 * dispatch() 为纯分发（零打印，供渠道消息复用并回发输出）；
 * handle() 为终端路径的打印包装：
 * false → 非 "/" 开头（交回 REPL 走 LLM，原文）；
 * true  → 命令域已处理，跳过本轮（永不进 LLM）；
 * string → 命令域已处理，该字符串作为 user message 转发给 LLM（/<skill-name> 快捷执行）。
 */
export class CommandDispatcher {
  private commands = new Map<string, Command>();

  constructor(private ctx: CommandContext) {}

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd);
  }

  listCommands(): Command[] {
    return [...this.commands.values()];
  }

  dispatch(input: string): DispatchResult {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return { kind: "not-command" };

    const spaceIdx = trimmed.search(/\s/);
    const cmdName = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      // skill 快捷执行 fallback：先查注册表，内置命令天然优先于同名 skill
      const forward = this.ctx.skills?.activateForExecution(cmdName, args) ?? null;
      if (forward !== null) {
        return { kind: "forward", text: forward, notice: `Skill "${cmdName}" activated.` };
      }
      const available = this.listCommands()
        .map((c) => `  /${c.name} — ${c.description}`)
        .join("\n");
      return { kind: "handled", output: `Unknown command: /${cmdName}\nAvailable commands:\n${available}` };
    }

    return { kind: "handled", output: cmd.execute(args, this.ctx) };
  }

  handle(input: string): boolean | string {
    const result = this.dispatch(input);
    if (result.kind === "not-command") return false;
    if (result.kind === "forward") {
      console.log(result.notice);
      return result.text;
    }
    if (result.output) console.log(result.output);
    return true;
  }
}
