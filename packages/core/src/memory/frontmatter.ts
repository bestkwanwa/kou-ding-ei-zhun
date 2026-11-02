export interface Frontmatter {
  [key: string]: string;
}

const KEY_VALUE_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

/**
 * 解析文件开头的 `---` 包裹块（扁平 key: value）。
 * 无 frontmatter 或块未闭合时返回空 fm、原文作为 body。
 */
export function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { fm: {}, body: raw };

  const fm: Frontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      return { fm, body: lines.slice(i + 1).join("\n") };
    }
    const m = KEY_VALUE_RE.exec(line);
    if (m) fm[m[1]] = m[2];
  }
  return { fm: {}, body: raw };
}

/** 序列化为 "---\nkey: value\n---\n"，保持插入顺序；值原样写入（可含冒号） */
export function serializeFrontmatter(fm: Frontmatter): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n`;
}
