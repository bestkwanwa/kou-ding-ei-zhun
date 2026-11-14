export interface SkillFile {
  /** 目录名：规范 id 与调用名 */
  slug: string;
  /** frontmatter name（缺省 = slug），仅展示 */
  name: string;
  /** 一行描述（缺省从正文首行派生） */
  description: string;
  /** markdown 正文（读取时截断，永不回写） */
  body: string;
  /** skill 目录绝对路径 */
  path: string;
}

export const SKILL_FILENAME = "SKILL.md";
/** 单个 skill 正文行数上限（读取时截断） */
export const MAX_SKILL_LINES = 500;
/** 单个 skill 正文字符上限（读取时截断） */
export const MAX_SKILL_CHARS = 10000;
/** description（含 frontmatter 显式值）长度上限 */
export const MAX_SKILL_DESCRIPTION_CHARS = 160;
/** 索引段注入 system prompt 的总长度上限 */
export const MAX_SKILL_INDEX_CHARS = 2000;
/** 已激活 skill 正文注入 system prompt 的总长度上限 */
export const MAX_LOADED_INJECTION_CHARS = 30000;
/** 目录名白名单，兼防路径穿越 */
export const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
