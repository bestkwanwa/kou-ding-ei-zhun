import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { RiskClassification, RiskLevel } from "./types.js";

// --- 规则数据 ---

export interface RiskRule {
  /** 规则 id，进 reason 与日志 */
  id: string;
  /** 对完整原始命令串做匹配（子串匹配，可捕获 "ls; sudo x"、"$(rm -rf /)" 等注入形态） */
  pattern: RegExp;
  reason: string;
}

/** 全角色拒绝的命令（不可逆 / 特权提升 / 系统级破坏） */
export const DANGEROUS_RULES: readonly RiskRule[] = [
  { id: "rm-root", pattern: /\brm\s+(?:-[a-zA-Z-]*r[a-zA-Z-]*\s+)+(?:\/|~|\$HOME)/, reason: "recursive delete targeting root/home" },
  { id: "rm-root-glob", pattern: /\brm\s+[^;|&]*\s\/\*/, reason: "delete of /*" },
  { id: "priv-esc", pattern: /(?:^|[\s;|&()])(?:sudo|doas)\b/, reason: "privilege escalation" },
  { id: "su", pattern: /(?:^|[\s;|&])su\b/, reason: "switching user" },
  { id: "system-wreck", pattern: /\b(?:mkfs|fdisk|shutdown|reboot|halt|poweroff)\b/, reason: "system-level destructive command" },
  { id: "dd-raw", pattern: /\bdd\b[^\n]*\bof=\/dev\//, reason: "raw device write" },
  { id: "curl-to-shell", pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi|k)?sh\b/, reason: "remote script executed directly" },
  { id: "pipe-to-shell", pattern: /\|\s*(?:sudo\s+)?(?:ba|z|fi|k)?sh\s*$/, reason: "piping content into a shell" },
  { id: "chmod-root-777", pattern: /\bchmod\s+-R\s+777\s+\//, reason: "world-writable root permissions" },
  { id: "publish", pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/, reason: "irreversible package publication" },
  { id: "history-wipe", pattern: /\bhistory\s+-c\b|>\s*~?\/\.bash_history/, reason: "shell history tampering" },
];

/** secrets 暴露模式：独立导出，safe 白名单守卫复用（否则 "cat .env" 会借 cat 白名单漏过） */
export const SECRETS_RE = /\.env\b|\.ssh\/|id_rsa|\bprintenv\b|\benv\b/;

/** 常规但有副作用的开发命令（owner 放行 + 警告；collaborator 拒绝） */
export const RISKY_RULES: readonly RiskRule[] = [
  { id: "fs-write", pattern: /\b(?:rm|mv|cp|mkdir|rmdir|touch|tee|ln)\b/, reason: "filesystem mutation" },
  { id: "redirect", pattern: />/, reason: "output redirection writes files" },
  { id: "pkg-mgmt", pattern: /\b(?:npm|pnpm|yarn|bun|npx|pip3?|cargo|brew|apt|apt-get)\b(?![^\n]*--version)/, reason: "package manager (installs/executes code)" },
  { id: "git-mutate", pattern: /\bgit\s+(?:add|commit|push|pull|clone|merge|rebase|reset|clean|checkout|switch|stash|restore|cherry-pick|apply|am|tag\s+\S|tag\s+-)/, reason: "mutating git operation" },
  { id: "exec-code", pattern: /\b(?:node|python3?|tsx|ts-node|make|vitest|jest|docker|podman|kubectl)\b(?![^\n]*(?:--version|-v\b))|(?:(?:^|\s)go\s+(?:run|build|test|get|install|generate|mod)\b)/, reason: "executes arbitrary code" },
  { id: "shell-exec", pattern: /(?:^|[\s;|&(])(?:ba|z|fi|k)?sh\b/, reason: "executes a shell" },
  { id: "network", pattern: /\b(?:curl|wget|ping|ssh|scp|rsync|nc|telnet|ftp)\b/, reason: "network access" },
  { id: "proc-ctl", pattern: /\b(?:kill|pkill|killall)\b/, reason: "process control" },
  { id: "perms", pattern: /\b(?:chmod|chown|chgrp)\b/, reason: "permission change" },
  { id: "secrets", pattern: SECRETS_RE, reason: "potential secret exposure" },
];

/** 整条命令必须是单个简单调用才可进 safe 白名单（锚定开头；不含 git tag——裸列表安全但 "git tag x" 变更） */
export const SAFE_COMMAND_RE =
  /^(?:ls|pwd|cat|head|tail|wc|file|stat|du|df|date|uname|whoami|id|which|type|echo|printf|grep|rg|find|basename|dirname|realpath|sort|uniq|diff)\b|^(?:git)\s+(?:status|log|diff|show|branch|rev-parse|ls-files|blame|remote|describe|shortlog)\b|^(?:node|npm|pnpm|yarn|bun|python3?|pip3?|cargo|ruby|java)\s+(?:--version|-v)\b|^go\s+version\b/;

/** 任何 shell 元字符都取消 safe 白名单资格（组合命令交给 risky 规则/LLM 判定） */
export const SHELL_METACHAR_RE = /[;|&<>()`\n]|\$\(/;
/** 会让"安全"二进制变危险的选项（find -delete 等） */
export const UNSAFE_OPTION_RE = /(?:-exec\b|-delete\b|-fprint)/;

// --- LLM 兜底 ---

const CLASSIFIER_SYSTEM_PROMPT = `You are a security classifier for shell commands run by a coding agent inside a
user's project directory. Classify the command into exactly one risk level:

- "safe": read-only, no side effects (listing/reading files, querying git state,
  version checks). Stdout only.
- "risky": modifies files, installs or executes code, uses the network, or can
  disrupt local state — but is routine, recoverable software development work.
- "dangerous": destructive, irreversible, escalates privileges, exfiltrates
  secrets, or affects the system outside the project directory.

Respond with ONLY a JSON object, no prose:
{"level": "safe" | "risky" | "dangerous", "reason": "<short explanation>"}`;

const DEFAULT_TIMEOUT_MS = 8_000;

const FALLBACK_CLASSIFICATION: RiskClassification = {
  level: "risky",
  reason: "unclassified command (LLM fallback unavailable/failed) — defaulting to risky",
  source: "default",
};

export interface BashRiskOptions {
  /** LLM 兜底的模型来源；null/未提供 = 跳过 LLM（按默认 risky） */
  getModel?: () => LanguageModelV3 | null;
  /** LLM 兜底超时（毫秒，默认 8000） */
  timeoutMs?: number;
}

function isRiskLevel(v: unknown): v is RiskLevel {
  return v === "safe" || v === "risky" || v === "dangerous";
}

/** 剥掉可选的 ``` 围栏后解析 JSON；失败返回 null */
function parseVerdict(text: string): { level: RiskLevel; reason: string } | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const { level, reason } = parsed as { level?: unknown; reason?: unknown };
      if (isRiskLevel(level)) {
        return { level, reason: typeof reason === "string" && reason.trim() ? reason.trim() : "classified by LLM" };
      }
    }
  } catch {
    // 落到返回 null
  }
  return null;
}

/**
 * bash 命令风险监测：规则为主 + LLM 兜底 + 内存缓存。
 * 判定顺序 DANGEROUS → SAFE（无元字符、无危险选项、不涉 secrets）→ RISKY → LLM → 默认 risky。
 * classify 永不抛错（内部一切异常都收敛为默认 risky）。
 */
export class BashRiskMonitor {
  private readonly cache = new Map<string, RiskClassification>();
  private readonly options: BashRiskOptions;

  constructor(options?: BashRiskOptions) {
    this.options = options ?? {};
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  /** 规则-only 快速通道；无规则命中返回 null（→ LLM 兜底） */
  classifyByRules(command: string): RiskClassification | null {
    for (const rule of DANGEROUS_RULES) {
      if (rule.pattern.test(command)) return { level: "dangerous", reason: `${rule.id}: ${rule.reason}`, source: "rule" };
    }
    // safe 白名单：单简单调用 + 无元字符 + 无危险选项 + 不涉 secrets
    if (
      SAFE_COMMAND_RE.test(command) &&
      !SHELL_METACHAR_RE.test(command) &&
      !UNSAFE_OPTION_RE.test(command) &&
      !SECRETS_RE.test(command)
    ) {
      return { level: "safe", reason: "safe allowlist", source: "rule" };
    }
    for (const rule of RISKY_RULES) {
      if (rule.pattern.test(command)) return { level: "risky", reason: `${rule.id}: ${rule.reason}`, source: "rule" };
    }
    return null;
  }

  /** 完整分类：规则 → 缓存 → LLM → 默认 risky。永不抛错。 */
  async classify(command: string): Promise<RiskClassification> {
    const byRules = this.classifyByRules(command);
    if (byRules) return byRules;

    const key = command.trim().replace(/\s+/g, " ");
    const cached = this.cache.get(key);
    if (cached) return cached;

    const verdict = await this.classifyByLlm(command);
    if (verdict) {
      this.cache.set(key, verdict);
      return verdict;
    }
    return FALLBACK_CLASSIFICATION;
  }

  /** LLM 兜底；不可用/超时/解析失败返回 null（→ 默认 risky） */
  private async classifyByLlm(command: string): Promise<RiskClassification | null> {
    try {
      const model = this.options.getModel?.() ?? null;
      if (!model) return null;
      const result = await generateText({
        model,
        system: CLASSIFIER_SYSTEM_PROMPT,
        prompt: `Command:\n${command}`,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const verdict = parseVerdict(result.text);
      if (!verdict) return null;
      return { level: verdict.level, reason: `llm: ${verdict.reason}`, source: "llm" };
    } catch {
      return null;
    }
  }
}
