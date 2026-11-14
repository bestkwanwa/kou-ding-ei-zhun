import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandDispatcher } from "./dispatcher.js";
import { createDefaultCommandDispatcher, DEFAULT_COMMANDS } from "./index.js";
import { SkillManager } from "../skills/index.js";
import type { Command } from "./types.js";

// --- Helpers ---

function makeCommand(overrides: Partial<Command> & { name: string }): Command {
  return {
    description: `Test command ${overrides.name}`,
    usage: `/${overrides.name} [args]`,
    execute: () => "ok",
    ...overrides,
  };
}

// --- Subject ---

describe("CommandDispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes a registered command and passes args through", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    const dispatcher = new CommandDispatcher({ cwd: "/tmp" });
    dispatcher.register(makeCommand({ name: "fake", execute: (args) => (calls.push(args), "ran") }));

    expect(dispatcher.handle("/fake  alpha   beta ")).toBe(true);
    expect(calls).toEqual(["alpha   beta"]); // 首空格后整体 trim，保留内部空白
    expect(log).toHaveBeenCalledWith("ran");
  });

  it("is case-insensitive on the command name", () => {
    const calls: string[] = [];
    const dispatcher = new CommandDispatcher({ cwd: "/tmp" });
    dispatcher.register(makeCommand({ name: "fake", execute: (args) => (calls.push(args), "") }));
    dispatcher.handle("/FAKE arg");
    expect(calls).toEqual(["arg"]);
  });

  it("returns false for non-command input (plain text, empty, mid-text slash)", () => {
    const dispatcher = new CommandDispatcher({ cwd: "/tmp" });
    dispatcher.register(makeCommand({ name: "fake" }));
    expect(dispatcher.handle("hello world")).toBe(false);
    expect(dispatcher.handle("")).toBe(false);
    expect(dispatcher.handle("please use /memory later")).toBe(false);
  });

  it("returns true and prints available commands for unknown /input", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dispatcher = new CommandDispatcher({ cwd: "/tmp" });
    dispatcher.register(makeCommand({ name: "alpha" }));
    dispatcher.register(makeCommand({ name: "beta" }));

    expect(dispatcher.handle("/nope arg")).toBe(true);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Unknown command: /nope");
    expect(output).toContain("/alpha");
    expect(output).toContain("/beta");
  });
});

describe("skill shortcut fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  let dir: string;

  function makeSkillCtx(): { cwd: string; skills: SkillManager } {
    dir = mkdtempSync(join(tmpdir(), "kda-skill-dispatch-"));
    const base = join(dir, ".kda", "skills");
    mkdirSync(join(base, "deploy"), { recursive: true });
    writeFileSync(join(base, "deploy", "SKILL.md"), "---\ndescription: Deploy the app\n---\nbody\n", "utf-8");
    return { cwd: dir, skills: new SkillManager(dir) };
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("unknown /<skill-name> activates the skill and returns the forward string", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeSkillCtx();
    const dispatcher = new CommandDispatcher(ctx);

    const result = dispatcher.handle("/deploy --prod");
    expect(typeof result).toBe("string");
    expect(result).toContain('Execute the skill "deploy" now');
    expect(result).toContain("Arguments: --prod");
    expect(ctx.skills.isLoaded("deploy")).toBe(true);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain('Skill "deploy" activated.');
    expect(output).not.toContain("Unknown command");
  });

  it("is case-insensitive on the skill name and omits Arguments when empty", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeSkillCtx();
    const dispatcher = new CommandDispatcher(ctx);

    const result = dispatcher.handle("/DEPLOY");
    expect(typeof result).toBe("string");
    expect(result).not.toContain("Arguments");
  });

  it("falls through to unknown-command output when no skill matches", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeSkillCtx();
    const dispatcher = new CommandDispatcher(ctx);
    dispatcher.register(makeCommand({ name: "alpha" }));

    expect(dispatcher.handle("/nope arg")).toBe(true);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Unknown command: /nope");
    expect(output).toContain("/alpha");
  });

  it("falls through when ctx has no skills manager (regression guard)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dispatcher = new CommandDispatcher({ cwd: "/tmp" });

    expect(dispatcher.handle("/deploy")).toBe(true);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Unknown command: /deploy");
  });

  it("registered commands win over same-named skills", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeSkillCtx();
    const dispatcher = new CommandDispatcher(ctx);
    dispatcher.register(makeCommand({ name: "deploy" }));

    expect(dispatcher.handle("/deploy arg")).toBe(true);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("ok"); // 内置命令执行，未走 skill 转发
    expect(ctx.skills.isLoaded("deploy")).toBe(false);
  });
});

describe("default commands", () => {
  it("DEFAULT_COMMANDS registers every command with usage set", () => {
    expect(DEFAULT_COMMANDS.length).toBeGreaterThan(0);
    for (const cmd of DEFAULT_COMMANDS) {
      expect(cmd.usage.startsWith(`/${cmd.name}`)).toBe(true);
    }
  });

  it("createDefaultCommandDispatcher registers exactly DEFAULT_COMMANDS", () => {
    const dispatcher = createDefaultCommandDispatcher({ cwd: "/tmp" });
    expect(dispatcher.listCommands().map((c) => c.name)).toEqual(DEFAULT_COMMANDS.map((c) => c.name));
  });
});
