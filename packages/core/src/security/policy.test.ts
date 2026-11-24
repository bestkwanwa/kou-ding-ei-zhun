import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./policy.js";

describe("evaluatePolicy", () => {
  // 非 shell 工具：guest 仅 readOnly
  it("guest + readOnly tool → allow", () => {
    expect(evaluatePolicy({ role: "guest", toolName: "read_file", readOnly: true })).toEqual({
      action: "allow",
      reason: "",
    });
  });

  it("guest + mutating tool → deny", () => {
    const d = evaluatePolicy({ role: "guest", toolName: "write_file", readOnly: false });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("read-only");
  });

  it("collaborator/owner + mutating tool → allow", () => {
    for (const role of ["collaborator", "owner"] as const) {
      expect(evaluatePolicy({ role, toolName: "write_file", readOnly: false }).action).toBe("allow");
    }
  });

  // run_command：guest 全拒（无需 risk）
  it("guest + run_command (no risk classified) → deny", () => {
    const d = evaluatePolicy({ role: "guest", toolName: "run_command", readOnly: false });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("guest");
  });

  it("collaborator + safe/risky shell → allow/deny", () => {
    expect(
      evaluatePolicy({ role: "collaborator", toolName: "run_command", readOnly: false, risk: "safe" }).action,
    ).toBe("allow");
    expect(
      evaluatePolicy({ role: "collaborator", toolName: "run_command", readOnly: false, risk: "risky" }).action,
    ).toBe("deny");
  });

  it("owner + safe/risky shell → allow/warn", () => {
    expect(
      evaluatePolicy({ role: "owner", toolName: "run_command", readOnly: false, risk: "safe" }).action,
    ).toBe("allow");
    expect(
      evaluatePolicy({ role: "owner", toolName: "run_command", readOnly: false, risk: "risky" }),
    ).toEqual({ action: "warn", reason: "risky shell command" });
  });

  // dangerous 全角色拒（含 owner，且优先于其他判定）
  it("dangerous denied for every role", () => {
    for (const role of ["owner", "collaborator", "guest"] as const) {
      const d = evaluatePolicy({ role, toolName: "run_command", readOnly: false, risk: "dangerous" });
      expect(d.action).toBe("deny");
      expect(d.reason).toContain("dangerous");
    }
  });

  it("dangerous reason instructs the model not to retry a variant", () => {
    const d = evaluatePolicy({ role: "owner", toolName: "run_command", readOnly: false, risk: "dangerous" });
    expect(d.reason).toContain("do NOT retry");
  });

  it("dangerous beats guest shell denial wording (checked first)", () => {
    // guest + dangerous：reason 应是 dangerous 的，而非 guest 不能跑 shell
    const d = evaluatePolicy({ role: "guest", toolName: "run_command", readOnly: false, risk: "dangerous" });
    expect(d.reason).toContain("dangerous");
    expect(d.reason).not.toContain("guest");
  });
});
