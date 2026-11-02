import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

// --- Subject ---

describe("parseFrontmatter", () => {
  it("parses key: value pairs and returns body", () => {
    const { fm, body } = parseFrontmatter("---\nname: build\ntype: project\n---\nline1\nline2");
    expect(fm).toEqual({ name: "build", type: "project" });
    expect(body).toBe("line1\nline2");
  });

  it("keeps values containing colons verbatim", () => {
    const { fm } = parseFrontmatter("---\ndescription: a: b: c\n---\nbody");
    expect(fm.description).toBe("a: b: c");
  });

  it("returns empty fm when there is no frontmatter block", () => {
    const { fm, body } = parseFrontmatter("just some markdown\n");
    expect(fm).toEqual({});
    expect(body).toBe("just some markdown\n");
  });

  it("returns empty fm when the block is unclosed", () => {
    const { fm, body } = parseFrontmatter("---\nname: x\nno closing marker");
    expect(fm).toEqual({});
    expect(body).toBe("---\nname: x\nno closing marker");
  });

  it("preserves body verbatim (blank lines, code fences)", () => {
    const body = "\n```ts\nconst a = 1;\n```\n\nend\n";
    const { body: parsed } = parseFrontmatter(`---\nname: x\n---\n${body}`);
    expect(parsed).toBe(body);
  });
});

describe("serializeFrontmatter", () => {
  it("round-trips through parseFrontmatter", () => {
    const fm = { name: "build-system", type: "project", description: "pnpm workspaces", updated: "2026-01-01T00:00:00.000Z" };
    const serialized = serializeFrontmatter(fm);
    const { fm: parsed } = parseFrontmatter(serialized + "body text");
    expect(parsed).toEqual(fm);
  });

  it("writes entries in insertion order between --- markers", () => {
    expect(serializeFrontmatter({ b: "2", a: "1" })).toBe("---\nb: 2\na: 1\n---\n");
  });
});
