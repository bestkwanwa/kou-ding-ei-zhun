import type { RagChunk } from "./types.js";
import { CHUNK_MAX_TOKENS, EST_CHARS_PER_TOKEN } from "./types.js";

const HEADING_RE = /^#{1,6} .+$/;
const SENTENCE_RE = /[^。！？!?.;；\n]+[。！？!?.;；]?/g;

const maxChars = CHUNK_MAX_TOKENS * EST_CHARS_PER_TOKEN; // 256 token ≈ 1024 chars

/**
 * 递归段落分块：先按双换行切段落；段落超限再按句子切并贪心打包；
 * 超长单句按字符硬切。纯函数。
 */
export function chunkMarkdown(text: string): RagChunk[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  const chunks: RagChunk[] = [];
  let heading = "";
  let ordinal = 0;

  const push = (content: string) => {
    chunks.push({ ordinal: ordinal++, heading, text: content });
  };

  for (const rawPara of paragraphs) {
    const lines = rawPara.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // 段首的标题行更新上下文
    let i = 0;
    while (i < lines.length && HEADING_RE.test(lines[i])) {
      heading = lines[i].replace(/^#{1,6} /, "");
      i++;
    }
    // 纯标题段：仅更新上下文，不产块
    if (i >= lines.length) continue;

    const content = lines.slice(i).join("\n");
    if (content.length <= maxChars) {
      push(content);
      continue;
    }

    // 超限段落：按句子切并贪心打包
    const sentences = content.match(SENTENCE_RE) ?? [content];
    let buf = "";
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        // 超长单句：先清空缓冲，再按字符硬切
        if (buf) {
          push(buf);
          buf = "";
        }
        for (let j = 0; j < sentence.length; j += maxChars) {
          push(sentence.slice(j, j + maxChars));
        }
        continue;
      }
      if (buf && buf.length + sentence.length > maxChars) {
        push(buf);
        buf = sentence;
      } else {
        buf += sentence;
      }
    }
    if (buf) push(buf);
  }

  return chunks;
}
