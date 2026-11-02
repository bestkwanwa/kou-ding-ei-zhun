import { describe, it, expect, vi, afterEach } from "vitest";
import { CommandDispatcher } from "./dispatcher.js";
import { createDefaultCommandDispatcher, DEFAULT_COMMANDS } from "./index.js";
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
