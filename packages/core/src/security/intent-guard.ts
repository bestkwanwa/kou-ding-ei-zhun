import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * 从命令串粗提取目标路径 token（flag 跳过；带 / 或 ~/、$HOME、.. 开头的都算），
 * 统一解析为绝对路径。故意粗糙——只服务于"同一目标此前被拒"的意图匹配，误报方向是安全侧。
 */
export function extractTargets(command: string, cwd: string): string[] {
  const targets: string[] = [];
  for (const token of command.split(/\s+/)) {
    if (token === "" || token.startsWith("-")) continue;
    const looksLikePath = token.includes("/") || /^(?:~|\$HOME|\.\.(?:\/|$))/.test(token);
    if (!looksLikePath) continue;
    targets.push(resolve(cwd, expandHome(token)));
  }
  return targets;
}

function expandHome(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/")) return homedir() + token.slice(1);
  if (token.startsWith("$HOME/")) return homedir() + token.slice(5);
  return token;
}

/**
 * 本轮意图记忆：dangerous 命令被拒时记录其目标；同一轮次内对同一目标的后续命令
 （哪怕只判 risky）一律 deny——防止 LLM 读到拒绝原因后换低危写法绕过（如 rm -rf 被拒后改用 rm）。
 记忆随下一个用户输入事件清空：用户再次触发 = 新一轮授权。
 误报方向是安全侧：对被拒目标的只读操作（如 ls 该目录）也会被拦，错误信息可自解释。
 */
export class DeniedIntentGuard {
  private readonly denied = new Set<string>();

  constructor(private readonly cwd: string) {}

  /** dangerous 拒绝时记录命令目标 */
  record(command: string): void {
    for (const target of extractTargets(command, this.cwd)) {
      this.denied.add(target);
    }
  }

  /** 命令是否命中此前被拒的目标 */
  isDenied(command: string): boolean {
    return extractTargets(command, this.cwd).some((target) => this.denied.has(target));
  }

  /** 下一个用户输入事件时清空（新一轮 = 重新授权） */
  reset(): void {
    this.denied.clear();
  }
}
