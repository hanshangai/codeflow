import fs from "node:fs";
import path from "node:path";

import type { KnowledgeAssetSearchHit } from "@codeflowai/shared";

import { openSqliteDb, type SqliteDb } from "../db/sqliteDb.js";
import { assertWorkspaceCodeflowaiDirectory, ensureWorkspaceCodeflowaiDirectory, inspectWorkspaceCodeflowaiFile, type WorkspaceCodeflowaiDirectoryIdentity } from "../codeflowai/workspaceCodeflowaiDirectory.js";
import { ensureWorkspacePrivateRuntimeGitExclude, WorkspacePrivateRuntimeGitError } from "../git/workspacePrivateRuntimeGitExclude.js";
import { KnowledgeAssetError } from "./knowledgeAssetFiles.js";
import { splitKnowledgeDocument } from "./knowledgeDocumentChunks.js";

const INDEX_FILE_NAME = "knowledge-search.sqlite";
const VECTOR_DIMENSION = 384;
const VECTOR_VERSION = "local_feature_hash_v1";
const INDEX_SCHEMA_VERSION = "4";
const MAX_RESULTS = 50;

export type KnowledgeSearchDocument = {
  nodeId: string;
  revisionId: string;
  contentHash: string;
  title: string;
  summary: string;
  tags: string[];
  content: string;
  path: string | null;
};

export type KnowledgeSearchResult = {
  backend: "hybrid_sqlite_fts5_vector";
  vectorBackend: typeof VECTOR_VERSION;
  items: Array<KnowledgeAssetSearchHit & {
    keywordScore: number;
    vectorScore: number;
    score: number;
    matchMode: "keyword" | "vector" | "hybrid";
  }>;
  issues: Array<{ nodeId: string; code: string; message: string }>;
};

type IndexedDocumentRow = KnowledgeSearchDocument & { id: string; chunkId: string; heading: string; startLine: number; endLine: number; vector: number[] };

/** 项目知识的本地派生检索索引；项目文件仍是唯一事实源，索引损坏时显式失败并可重建。 */
export class KnowledgeSearchIndex {
  private readonly workspacePath: string;

  /** 只记录工作区入口；每次访问重新确认物理目录及 Git 保护。 */
  constructor(workspacePath: string) {
    this.workspacePath = path.resolve(workspacePath);
  }

  /** 判断索引是否对应指定的资产树/版本清单。 */
  hasManifest(manifest: string): boolean {
    return this.withDb(db => {
      const rows = db.prepare("SELECT key, value FROM knowledge_search_meta WHERE key IN ('manifest', 'schema_version')").all() as Array<{ key: string; value: string }>;
      const metadata = new Map(rows.map(row => [row.key, row.value]));
      return metadata.get("schema_version") === INDEX_SCHEMA_VERSION && metadata.get("manifest") === manifest;
    });
  }

  /** 将原文按章节分块后重建本地索引，来源版本和行号保留到每个块。 */
  rebuild(documents: readonly KnowledgeSearchDocument[], manifest: string): void {
    this.withDb(db => {
      const rebuild = db.transaction(() => {
        db.exec("DELETE FROM knowledge_search_fts; DELETE FROM knowledge_search_documents; DELETE FROM knowledge_search_vectors; DELETE FROM knowledge_search_vector_terms;");
        for (const document of documents) this.insertDocument(db, document);
        this.setManifest(db, manifest);
      });
      rebuild();
    });
  }

  /** 单节点采用新版本时增量更新，避免批量生成反复扫描整棵资产树。 */
  upsert(document: KnowledgeSearchDocument, manifest: string): void {
    this.withDb(db => {
      const update = db.transaction(() => {
        this.deleteDocument(db, document.nodeId);
        this.insertDocument(db, document);
        this.setManifest(db, manifest);
      });
      update();
    });
  }

  /** 在资产树范围内执行关键词与向量混合排序。 */
  search(query: string, scopeNodeIds: readonly string[]): KnowledgeSearchResult {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return { backend: "hybrid_sqlite_fts5_vector", vectorBackend: VECTOR_VERSION, items: [], issues: [] };
    return this.withDb(db => {
      const allowed = new Set(scopeNodeIds);
      if (allowed.size === 0) return { backend: "hybrid_sqlite_fts5_vector", vectorBackend: VECTOR_VERSION, items: [], issues: [] };
      const keywordRows = this.readKeywordRows(db, normalizedQuery, allowed);
      const vectorQuery = createFeatureVector(normalizedQuery);
      const vectorRows = this.readVectorRows(db, allowed, normalizedQuery);
      const keywordRaw = new Map(keywordRows.map(row => [row.nodeId, Math.max(0, -Number(row.rank))]));
      const maxKeyword = Math.max(0, ...keywordRaw.values());
      const vectorRaw = new Map(vectorRows.map(row => [row.nodeId, cosine(vectorQuery, row.vector)]));
      const allIds = new Set([...keywordRaw.keys(), ...vectorRaw.keys()]);
      const rows = this.readDocuments(db, allIds);
      const hits = rows.map(document => {
        const keywordScore = maxKeyword > 0 ? (keywordRaw.get(document.id) ?? 0) / maxKeyword : 0;
        const vectorScore = Math.max(0, vectorRaw.get(document.id) ?? 0);
        const score = keywordScore * 0.5 + vectorScore * 0.5;
        return {
          nodeId: document.nodeId,
          title: document.title,
          excerpt: createExcerpt(document, normalizedQuery),
          path: document.path,
          contentHash: document.contentHash,
          chunkId: document.chunkId, heading: document.heading, startLine: document.startLine, endLine: document.endLine,
          keywordScore: roundScore(keywordScore),
          vectorScore: roundScore(vectorScore),
          score: roundScore(score),
          matchMode: keywordScore > 0.05 && vectorScore > 0.05 ? "hybrid" as const : keywordScore > 0.05 ? "keyword" as const : "vector" as const,
        };
      }).filter(item => item.keywordScore > 0 || item.vectorScore >= 0.08)
        .sort((a, b) => b.score - a.score || b.keywordScore - a.keywordScore || a.title.localeCompare(b.title))
        .slice(0, MAX_RESULTS);
      return { backend: "hybrid_sqlite_fts5_vector", vectorBackend: VECTOR_VERSION, items: hits, issues: [] };
    });
  }

  /** Git 保护成功后才开库；任何工件身份变化均显式失败并关闭本次连接。 */
  private withDb<T>(action: (db: SqliteDb) => T): T {
    try {
      const workspaceRoot = fs.realpathSync.native(this.workspacePath);
      ensureWorkspacePrivateRuntimeGitExclude(workspaceRoot);
      const directory = ensureWorkspaceCodeflowaiDirectory(workspaceRoot);
      const before = inspectIndexArtifacts(directory);
      const db = openSqliteDb(path.join(directory.directoryPath, INDEX_FILE_NAME), { busyTimeoutMs: 5_000 });
      let operationFailed = false;
      let operationError: unknown;
      try {
        let opened = inspectIndexArtifacts(directory, before);
        if (!opened[0]) throw new Error("知识检索主库打开后缺失");
        ensureSchema(db);
        opened = inspectIndexArtifacts(directory, opened);
        const result = action(db);
        inspectIndexArtifacts(directory, opened);
        return result;
      } catch (error) {
        operationFailed = true;
        operationError = error;
        throw error;
      } finally {
        try {
          db.close();
        } catch (closeError) {
          if (operationFailed) throw new AggregateError([operationError, closeError], `知识索引访问失败：${operationError instanceof Error ? operationError.message : String(operationError)}；关闭失败：${closeError instanceof Error ? closeError.message : String(closeError)}`, { cause: operationError });
          throw closeError;
        }
      }
    } catch (error) {
      if (error instanceof KnowledgeAssetError) throw error;
      if (error instanceof WorkspacePrivateRuntimeGitError && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED") {
        throw Object.assign(new KnowledgeAssetError(error.code, "工作区 .codeflowai 已被 Git 跟踪，无法写入新的知识检索缓存；请先人工处理跟踪状态后重试，系统不会自动取消跟踪。", 409), { cause: error });
      }
      const cause = error instanceof Error ? error.message : String(error);
      throw Object.assign(new KnowledgeAssetError("KNOWLEDGE_SEARCH_INDEX_FAILED", `知识检索索引不可用：${cause.slice(0, 500)}`, 500), { cause: error });
    }
  }

  /** 每块独立排序，原资产 ID 用于范围和权限过滤。 */
  private insertDocument(db: SqliteDb, document: KnowledgeSearchDocument): void {
    for (const chunk of splitKnowledgeDocument(document.content, 2000, document.path ?? "")) this.insertChunk(db, document, chunk);
  }

  /** 保存原文字块和来源定位，摘要参与排序但不替代原文引用。 */
  private insertChunk(db: SqliteDb, source: KnowledgeSearchDocument, chunk: ReturnType<typeof splitKnowledgeDocument>[number]): void {
    const document = { ...source, content: chunk.content };
    const id = `${source.nodeId}:${chunk.chunkId}`;
    const featureWeights = createFeatureFeatures(`${document.title}\n${document.summary}\n${document.tags.join(" ")}\n${document.content}`);
    const vector = createDenseVector(featureWeights);
    db.prepare(`INSERT INTO knowledge_search_documents
      (node_id, source_node_id, chunk_id, heading, start_line, end_line, revision_id, content_hash, title, summary, tags, content, asset_path, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`).run(
      id, source.nodeId, chunk.chunkId, chunk.heading, chunk.startLine, chunk.endLine, document.revisionId, document.contentHash, document.title, document.summary,
      document.tags.join("\n"), document.content, document.path, Date.now(),
    );
    db.prepare("INSERT INTO knowledge_search_fts(node_id, title, summary, tags, content) VALUES (?, ?, ?, ?, ?)").run(
      id, document.title, document.summary, document.tags.join("\n"), document.content,
    );
    db.prepare("INSERT INTO knowledge_search_vectors(node_id, revision_id, content_hash, dimension, vector_json, vector_version) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, document.revisionId, document.contentHash, VECTOR_DIMENSION, JSON.stringify(vector), VECTOR_VERSION,
    );
    const featureStatement = db.prepare("INSERT INTO knowledge_search_vector_terms(feature_id, node_id, weight) VALUES (?, ?, ?)");
    for (const [featureId, weight] of featureWeights) featureStatement.run(featureId, id, weight);
  }

  /** 删除资产全部派生块，增量更新不残留旧正文。 */
  private deleteDocument(db: SqliteDb, nodeId: string): void {
    for (const table of ["knowledge_search_fts", "knowledge_search_vectors", "knowledge_search_vector_terms"]) db.prepare(`DELETE FROM ${table} WHERE node_id IN (SELECT node_id FROM knowledge_search_documents WHERE source_node_id = ?)`).run(nodeId);
    db.prepare("DELETE FROM knowledge_search_documents WHERE source_node_id = ?").run(nodeId);
  }

  private setManifest(db: SqliteDb, manifest: string): void {
    db.prepare("INSERT INTO knowledge_search_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(INDEX_SCHEMA_VERSION);
    db.prepare("INSERT INTO knowledge_search_meta(key, value) VALUES ('manifest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(manifest);
  }

  private readKeywordRows(db: SqliteDb, query: string, allowed: Set<string>): Array<{ nodeId: string; rank: number }> {
    const terms = query.split(/\s+/u).filter(Boolean);
    const allowedIds = [...allowed];
    const scopePlaceholders = allowedIds.map(() => "?").join(",");
    const ftsQuery = terms.length && terms.every(term => Array.from(term).length >= 3)
      ? terms.map(term => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ")
      : null;
    const rows = ftsQuery
      ? db.prepare(`SELECT node_id AS nodeId, bm25(knowledge_search_fts, 8.0, 4.0, 2.0, 1.0) AS rank
        FROM knowledge_search_fts
        WHERE knowledge_search_fts MATCH ? AND node_id IN (SELECT node_id FROM knowledge_search_documents WHERE source_node_id IN (${scopePlaceholders}))
        ORDER BY rank LIMIT 200`).all(ftsQuery, ...allowedIds) as Array<{ nodeId: string; rank: number }>
      : [];
    if (rows.length) return rows;
    const clauses = terms.map(() => "(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')").join(" AND ");
    const likes = terms.flatMap(term => {
      const like = `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      return [like, like, like, like];
    });
    return db.prepare(`SELECT node_id AS nodeId, -1 AS rank
      FROM knowledge_search_documents
      WHERE ${clauses} AND source_node_id IN (${scopePlaceholders}) LIMIT 200`).all(...likes, ...allowedIds) as Array<{ nodeId: string; rank: number }>;
  }

  private readVectorRows(db: SqliteDb, allowed: Set<string>, query: string): Array<{ nodeId: string; vector: number[] }> {
    const queryFeatures = createFeatureFeatures(query).map(([featureId]) => featureId);
    if (!queryFeatures.length || !allowed.size) return [];
    const featurePlaceholders = queryFeatures.map(() => "?").join(",");
    const allowedIds = [...allowed];
    const scopePlaceholders = allowedIds.map(() => "?").join(",");
    const candidateRows = db.prepare(`SELECT DISTINCT node_id AS nodeId
      FROM knowledge_search_vector_terms
      WHERE feature_id IN (${featurePlaceholders}) AND node_id IN (SELECT node_id FROM knowledge_search_documents WHERE source_node_id IN (${scopePlaceholders}))`).all(...queryFeatures, ...allowedIds) as Array<{ nodeId: string }>;
    const candidateIds = candidateRows.map(row => row.nodeId);
    if (!candidateIds.length) return [];
    const rows: Array<{ nodeId: string; vectorJson: string }> = [];
    for (let offset = 0; offset < candidateIds.length; offset += 500) {
      const chunk = candidateIds.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(",");
      rows.push(...db.prepare(`SELECT node_id AS nodeId, vector_json AS vectorJson FROM knowledge_search_vectors WHERE node_id IN (${placeholders})`).all(...chunk) as Array<{ nodeId: string; vectorJson: string }>);
    }
    return rows.map(row => {
      let vector: unknown;
      try { vector = JSON.parse(row.vectorJson); } catch { throw new KnowledgeAssetError("KNOWLEDGE_SEARCH_INDEX_FAILED", `知识向量索引损坏：${row.nodeId}`, 500); }
      if (!Array.isArray(vector) || vector.length !== VECTOR_DIMENSION || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) {
        throw new KnowledgeAssetError("KNOWLEDGE_SEARCH_INDEX_FAILED", `知识向量维度无效：${row.nodeId}`, 500);
      }
      return { nodeId: row.nodeId, vector: vector as number[] };
    });
  }

  /** 分批读取候选块，文档分块数量不受原知识节点数限制。 */
  private readDocuments(db: SqliteDb, nodeIds: Set<string>): IndexedDocumentRow[] {
    const ids = [...nodeIds];
    const rows: Array<Omit<IndexedDocumentRow, "tags" | "vector"> & { tags: string }> = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500), placeholders = batch.map(() => "?").join(",");
      rows.push(...db.prepare(`SELECT node_id AS id, source_node_id AS nodeId, chunk_id AS chunkId, heading, start_line AS startLine, end_line AS endLine, revision_id AS revisionId, content_hash AS contentHash,
        title, summary, tags, content, asset_path AS path FROM knowledge_search_documents WHERE node_id IN (${placeholders})`).all(...batch) as typeof rows);
    }
    return rows.map(row => ({ ...row, tags: row.tags ? row.tags.split("\n").filter(Boolean) : [], vector: [] }));
  }
}

/** 检查主库和 SQLite sidecar；原身份不可替换，孤儿 sidecar 不自动覆盖或清理。 */
function inspectIndexArtifacts(
  directory: WorkspaceCodeflowaiDirectoryIdentity,
  expected?: ReturnType<typeof inspectWorkspaceCodeflowaiFile>[],
): ReturnType<typeof inspectWorkspaceCodeflowaiFile>[] {
  assertWorkspaceCodeflowaiDirectory(directory);
  const files = ["", "-wal", "-shm", "-journal"].map(suffix => inspectWorkspaceCodeflowaiFile(directory, `${INDEX_FILE_NAME}${suffix}`));
  if (!files[0] && files.slice(1).some(Boolean)) throw new Error("知识检索主库缺失但 sidecar 仍存在，请人工处理后重试");
  for (let index = 0; index < files.length; index += 1) {
    const previous = expected?.[index], current = files[index];
    if (previous && (!current || previous.dev !== current.dev || previous.ino !== current.ino)) {
      throw new Error(`知识检索工件在访问期间被替换：${previous.path}`);
    }
  }
  assertWorkspaceCodeflowaiDirectory(directory);
  return files;
}

/** 创建轻量确定性特征向量；当前没有 embedding provider，后续可替换而不改变检索协议。 */
export function createFeatureVector(value: string): number[] {
  return createDenseVector(createFeatureFeatures(value));
}

/** 提取稀疏特征桶；桶编号同时作为向量倒排索引的键。 */
function createFeatureFeatures(value: string): Array<[number, number]> {
  const raw = new Map<number, number>();
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const chars = Array.from(normalized).filter(char => /[\p{L}\p{N}]/u.test(char));
  const add = (feature: string, weight: number) => {
    const featureId = hashFeature(feature) % VECTOR_DIMENSION;
    raw.set(featureId, (raw.get(featureId) ?? 0) + weight);
  };
  for (const char of chars) add(char, 1);
  for (let index = 0; index + 1 < chars.length; index += 1) add(`${chars[index]}${chars[index + 1]}`, 1.5);
  for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) add(`word:${token}`, 2);
  const length = Math.sqrt([...raw.values()].reduce((sum, item) => sum + item * item, 0));
  return length ? [...raw.entries()].map(([featureId, weight]) => [featureId, weight / length]) : [];
}

function createDenseVector(features: readonly [number, number][]): number[] {
  const vector = Array<number>(VECTOR_DIMENSION).fill(0);
  for (const [featureId, weight] of features) vector[featureId] = weight;
  return vector;
}

function hashFeature(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    for (const byte of Buffer.from(char, "utf8")) hash = Math.imul(hash ^ byte, 16777619);
  }
  return hash >>> 0;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let result = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) result += left[index]! * right[index]!;
  return Math.max(0, Math.min(1, result));
}

function roundScore(value: number): number { return Math.round(value * 10_000) / 10_000; }

function createExcerpt(document: KnowledgeSearchDocument, query: string): string {
  const text = document.content.trim();
  const lower = text.toLocaleLowerCase();
  const position = Math.max(0, lower.indexOf(query.toLocaleLowerCase()) - 70);
  return text.slice(position, position + 320);
}

function ensureSchema(db: SqliteDb): void {
  // 旧检索表是可重建缓存，升级只影响派生索引，不修改原文或知识版本。
  const columns = db.prepare("PRAGMA table_info(knowledge_search_documents)").all() as Array<{ name: string }>;
  if (columns.length && !columns.some(column => column.name === "source_node_id")) db.transaction(() => db.exec("DROP TABLE IF EXISTS knowledge_search_fts; DROP TABLE IF EXISTS knowledge_search_documents; DROP TABLE IF EXISTS knowledge_search_vectors; DROP TABLE IF EXISTS knowledge_search_vector_terms; DROP TABLE IF EXISTS knowledge_search_meta;"))();
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_search_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_search_documents (
      node_id TEXT PRIMARY KEY,
      source_node_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      heading TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      revision_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags TEXT NOT NULL,
      content TEXT NOT NULL,
      asset_path TEXT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search_fts USING fts5(
      node_id UNINDEXED,
      title,
      summary,
      tags,
      content,
      tokenize = 'trigram'
    );
    CREATE TABLE IF NOT EXISTS knowledge_search_vectors (
      node_id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      vector_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_search_vector_terms (
      feature_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY(feature_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_search_vector_terms_feature
      ON knowledge_search_vector_terms(feature_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_search_vectors_version
      ON knowledge_search_vectors(vector_version, node_id);
  `);
}
