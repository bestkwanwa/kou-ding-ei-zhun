import type { Command, CommandContext } from "./types.js";

/**
 * 斜杠命令分发器："/" 前缀输入在进入 LLM 前被拦截。
 * 非 "/" 开头 → false（交回 REPL 走 LLM）；"/" 开头 → true（命令域，永不进 LLM）。
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

  handle(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return false;

    const spaceIdx = trimmed.search(/\s/);
    const cmdName = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      const available = this.listCommands()
        .map((c) => `  /${c.name} — ${c.description}`)
        .join("\n");
      console.log(`Unknown command: /${cmdName}\nAvailable commands:\n${available}`);
      return true;
    }

    const output = cmd.execute(args, this.ctx);
    if (output) console.log(output);
    return true;
  }
}
