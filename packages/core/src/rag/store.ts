import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { RagChunk, RagDoc } from "./types.js";

interface ChunkRow extends RagChunk {
  id: number;
  path: string;
}

/**
 * SQLite + sqlite-vec + FTS5 三表存储：
 * documents（文件级元数据）/ chunks+chunks_fts（分块与关键词索引）/ chunks_vec（向量）。
 * vec 表在首次 ingest 得知维度后创建；维度/模型变更时自动重置并要求重新 ingest。
 */
export class RagStore {
  private db!: Database.Database;

  constructor(private dbPath: string) {}

  init(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    sqliteVec.load(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='trigram');
    `);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private vecTableExists(): boolean {
    const row = this.db.prepare("SELECT count(*) c FROM sqlite_master WHERE name = 'chunks_vec'").get() as { c: number };
    return row.c > 0;
  }

  /** 维度/模型变更时重置向量与已索引内容（旧向量不兼容，需重新 ingest） */
  ensureVecTable(dims: number, model: string): void {
    const existingDims = this.getMeta("dims");
    const existingModel = this.getMeta("embedding_model");
    if (existingDims === String(dims) && existingModel === model && this.vecTableExists()) return;

    if (this.vecTableExists()) {
      this.db.exec("DROP TABLE chunks_vec");
      this.db.exec("DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM documents;");
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dims}] distance_metric=cosine)`,
    );
    this.setMeta("dims", String(dims));
    this.setMeta("embedding_model", model);
  }

  findDocByPath(path: string): { hash: string } | null {
    const row = this.db.prepare("SELECT hash FROM documents WHERE path = ?").get(path) as { hash: string } | undefined;
    return row ?? null;
  }

  documentCount(): number {
    return (this.db.prepare("SELECT count(*) c FROM documents").get() as { c: number }).c;
  }

  /** 整文件替换：事务内清理旧分块（chunks/fts/vec）后重写 */
  replaceDocument(doc: RagDoc, chunks: RagChunk[], vectors: number[][]): void {
    const tx = this.db.transaction(() => {
      this.removeDocByPath(doc.path);
      const info = this.db
        .prepare("INSERT INTO documents(path, hash, chunk_count, updated_at) VALUES (?, ?, ?, ?)")
        .run(doc.path, doc.hash, chunks.length, new Date().toISOString()) as Database.RunResult;
      const docId = Number(info.lastInsertRowid);

      const insChunk = this.db.prepare("INSERT INTO chunks(doc_id, ordinal, heading, text) VALUES (?, ?, ?, ?)");
      const insFts = this.db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)");
      // vec0 主键必须以 BigInt 绑定（better-sqlite3 的 number 绑定会被 vec0 拒绝）
      const insVec = this.db.prepare("INSERT INTO chunks_vec(chunk_id, embedding) VALUES (?, ?)");
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = Number(insChunk.run(docId, chunks[i].ordinal, chunks[i].heading, chunks[i].text).lastInsertRowid);
        insFts.run(chunkId, chunks[i].text);
        insVec.run(BigInt(chunkId), JSON.stringify(vectors[i]));
      }
    });
    tx();
  }

  private removeDocByPath(path: string): void {
    const doc = this.db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number } | undefined;
    if (!doc) return;
    this.removeDocById(doc.id);
  }

  private removeDocById(docId: number): void {
    const chunkIds = (this.db.prepare("SELECT id FROM chunks WHERE doc_id = ?").all(docId) as { id: number }[]).map((r) => r.id);
    const delVec = this.db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?");
    const delFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    for (const id of chunkIds) {
      if (this.vecTableExists()) delVec.run(BigInt(id));
      delFts.run(id);
    }
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(docId); // chunks 级联删除
  }

  /** 清理知识目录中已不存在的文件，返回清理数 */
  deleteStaleDocs(validPaths: string[]): number {
    const valid = new Set(validPaths);
    const rows = this.db.prepare("SELECT id, path FROM documents").all() as { id: number; path: string }[];
    let removed = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        if (!valid.has(row.path)) {
          this.removeDocById(row.id);
          removed++;
        }
      }
    });
    tx();
    return removed;
  }

  /** 向量 KNN（余弦相似 = 1 - distance）；vec 表未建时返回 [] */
  searchVector(vec: number[], n: number): { chunkId: number; sim: number }[] {
    if (!this.vecTableExists()) return [];
    const rows = this.db
      .prepare("SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?")
      .all(JSON.stringify(vec), n) as { chunk_id: number; distance: number }[];
    return rows.map((r) => ({ chunkId: r.chunk_id, sim: 1 - r.distance }));
  }

  /** FTS5 关键词检索（trigram，对 CJK 友好），score = -bm25（越大越好） */
  searchKeyword(query: string, n: number): { chunkId: number; score: number }[] {
    const terms = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
    if (terms.length === 0) return [];
    const rows = this.db
      .prepare("SELECT rowid, -bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score DESC LIMIT ?")
      .all(terms.join(" OR "), n) as { rowid: number; score: number }[];
    return rows.map((r) => ({ chunkId: r.rowid, score: r.score }));
  }

  /** 批量取回分块正文（含所属文档路径） */
  getChunks(ids: number[]): ChunkRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT c.id, c.ordinal, c.heading, c.text, d.path
         FROM chunks c JOIN documents d ON d.id = c.doc_id
         WHERE c.id IN (${placeholders})`,
      )
      .all(...ids) as ChunkRow[];
  }

  close(): void {
    this.db.close();
  }
}
