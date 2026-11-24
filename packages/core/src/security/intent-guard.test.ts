import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeniedIntentGuard, extractTargets } from "./intent-guard.js";

const CWD = "/tmp/kda-guard-test";

describe("extractTargets", () => {
  it("extracts path-like tokens, skips flags and bare words", () => {
    expect(extractTargets("rm -rf /a/b.txt", CWD)).toEqual(["/a/b.txt"]);
    expect(extractTargets("rm -rf ./x relative.txt", CWD)).toEqual([join(CWD, "x")]);
    expect(extractTargets("ls -la", CWD)).toEqual([]);
    expect(extractTargets("echo hello", CWD)).toEqual([]);
  });

  it("expands ~ and $HOME to the real home directory", () => {
    expect(extractTargets("rm -rf ~/foo", CWD)).toEqual([join(homedir(), "foo")]);
    expect(extractTargets("rm -rf ~", CWD)).toEqual([homedir()]);
    expect(extractTargets("rm -rf $HOME/foo", CWD)).toEqual([join(homedir(), "foo")]);
  });

  it("resolves .. relative to cwd", () => {
    expect(extractTargets("rm ../escape.txt", CWD)).toEqual(["/tmp/escape.txt"]);
  });
});

describe("DeniedIntentGuard", () => {
  it("records denied targets and flags later commands on the same target", () => {
    const g = new DeniedIntentGuard(CWD);
    expect(g.isDenied("rm /a/b.txt")).toBe(false);
    g.record("rm -rf /a/b.txt");
    expect(g.isDenied("rm /a/b.txt")).toBe(true);
    // 相对/绝对路径等价
    expect(g.isDenied("cd /a && rm b.txt")).toBe(false); // "b.txt" 无 / 不算目标 token
    expect(g.isDenied("rm -rf /a/b.txt")).toBe(true);
  });

  it("does not flag unrelated targets", () => {
    const g = new DeniedIntentGuard(CWD);
    g.record("rm -rf /a/b.txt");
    expect(g.isDenied("rm /other/file.txt")).toBe(false);
    // 目录被拒 ≠ 其子路径读文件被拒（精确路径匹配）
    expect(g.isDenied("cat /a/b.txt.bak")).toBe(false);
  });

  it("reset clears the memory (new user turn = re-authorization)", () => {
    const g = new DeniedIntentGuard(CWD);
    g.record("rm -rf /a/b.txt");
    g.reset();
    expect(g.isDenied("rm /a/b.txt")).toBe(false);
  });

  it("matches equivalent forms of the same target (relative vs absolute vs ~)", () => {
    const g = new DeniedIntentGuard(homedir());
    g.record("rm -rf ~/x");
    expect(g.isDenied(`rm ${join(homedir(), "x")}`)).toBe(true);
    expect(g.isDenied("rm ./x")).toBe(true);
  });
});
