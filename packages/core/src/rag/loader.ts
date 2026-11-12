import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RagDoc } from "./types.js";

/** 递归收集 .kda/knowledge/ 下全部 .md 文档；目录不存在或为空返回 [] */
export function loadKnowledgeDocs(cwd: string): RagDoc[] {
  const root = resolve(cwd, ".kda", "knowledge");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  files.sort();
  return files.map((f) => {
    const content = readFileSync(f, "utf-8");
    return {
      path: relative(root, f),
      content,
      hash: createHash("sha256").update(content).digest("hex"),
    };
  });
}
