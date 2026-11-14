export type MemoryType = "user" | "feedback" | "dynamic" | "resource";

export interface MemoryFile {
  /** 完整 id：<type>-<slug>，与文件名 <id>.md 一致 */
  id: string;
  type: MemoryType;
  /** 一行描述 */
  description: string;
  /** ISO 时间戳，只由代码写（即最近一次写入时间） */
  updated: string;
  /** ISO 时间戳：最近一次显式读取（memory 工具 read / /memory show）；loadAll 不计入 */
  lastRead?: string;
  /** markdown 正文 */
  body: string;
}

export interface MemoryInput {
  type: MemoryType;
  /** kebab-case 短名；已带类型前缀会被剥掉后重组（幂等） */
  slug: string;
  description: string;
  body: string;
}

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "dynamic", "resource"];

export const MAX_MEMORY_FILES = 10;
/** 单个记忆文件（含 frontmatter）行数上限 */
export const MAX_FILE_LINES = 200;
/** 单个记忆文件（含 frontmatter）字符上限 */
export const MAX_FILE_CHARS = 4000;
export const MAX_DESCRIPTION_CHARS = 160;
export const MAX_INDEX_CHARS = 1000;
/** 注入 system prompt 的总长度上限 */
export const MAX_INJECTION_CHARS = 8000;
/** 完整 id（type-slug）最大长度 */
export const MAX_NAME_CHARS = 50;
/** kebab-case 白名单，兼防路径穿越 */
export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** 各类型记忆的保质期（天）：超过未读且未写 → lint / 自动整理的过期候选 */
export const MEMORY_TTL_DAYS: Record<MemoryType, number> = {
  user: 180,
  feedback: 180,
  dynamic: 30,
  resource: 14,
};

/** 记忆整理的保留标记 id：正文存整理报告，代码写的 updated 字段即「上次整理时间」 */
export const MAINTENANCE_MARKER_ID = "dynamic-memory-maintenance";
