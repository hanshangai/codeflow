import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqliteRunResult = {
  changes?: number | bigint;
  lastInsertRowid?: number | bigint;
};

export type SqliteStatement = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => SqliteRunResult;
  iterate: (...params: unknown[]) => IterableIterator<unknown>;
};

export type SqliteTransactionOptions = {
  mode?: "deferred" | "immediate" | "exclusive";
  requireOutermost?: boolean;
};

export type SqliteDb = {
  prepare: (sql: string) => SqliteStatement;
  exec: (sql: string) => void;
  pragma: (sql: string, options?: { simple?: boolean }) => unknown;
  transaction: <T extends (...args: any[]) => any>(fn: T, options?: SqliteTransactionOptions) => T;
  close: () => void;
  setAccessGuard?: (guard: (() => void) | null) => void;
};

export type SqliteOpenOptions = {
  busyTimeoutMs?: number;
  readonly?: boolean;
  fileMustExist?: boolean;
  onInitializationCleanupFailure?: (close: () => void) => void;
  assertAccess?: () => void;
  statementCacheSize?: number;
};

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 10_000;

/** 使用 Node 内置 SQLite 打开普通数据库。 */
export function openSqliteDb(filename: string, options?: SqliteOpenOptions): SqliteDb {
  return new NodeSqliteDb(filename, options);
}

class NodeSqliteDb implements SqliteDb {
  private readonly inner: DatabaseSync;
  private transactionDepth = 0;
  private savepointSeq = 0;
  private closed = false;
  private accessGuard: (() => void) | null;
  private readonly statements = new Map<string, SqliteStatement>();
  private readonly statementCacheSize: number;

  /** 创建连接并设置选项；初始化失败先关闭原生连接，双错一并抛出。 */
  constructor(filename: string, options?: SqliteOpenOptions) {
    this.accessGuard = options?.assertAccess ?? null;
    this.statementCacheSize = options?.statementCacheSize ?? 0;
    assertExistingSqliteFile(filename, options);
    this.inner = new DatabaseSync(filename, { readOnly: options?.readonly === true });
    try {
      this.inner.exec(`PRAGMA busy_timeout = ${normalizeBusyTimeoutMs(options?.busyTimeoutMs)}`);
    } catch (error) {
      try {
        this.inner.close();
      } catch (closeError) {
        try { options?.onInitializationCleanupFailure?.(() => this.close()); }
        catch (handoffError) { throw new AggregateError([error, closeError, handoffError], "SQLITE_OPEN_CLEANUP_HANDOFF_FAILED", { cause: error }); }
        throw new AggregateError([error, closeError], "SQLITE_OPEN_CLEANUP_FAILED", { cause: error });
      }
      throw error;
    }
  }

  /** 编译 SQL，返回项目同步调用所需的 statement 适配器。 */
  prepare(sql: string): SqliteStatement {
    this.assertAccess();
    const existing = this.statements.get(sql);
    if (existing) return existing;
    const statement = new NodeSqliteStatement(this.inner.prepare(sql), () => this.assertAccess());
    if (this.statementCacheSize > 0) {
      this.statements.set(sql, statement);
      if (this.statements.size > this.statementCacheSize) this.statements.delete(this.statements.keys().next().value!);
    }
    return statement;
  }

  /** 执行一段 SQL 脚本。 */
  exec(sql: string): void {
    this.assertAccess();
    this.inner.exec(sql);
    this.statements.clear();
  }

  /** 执行 PRAGMA；simple 模式返回第一行第一列。 */
  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const rows = this.prepare(`PRAGMA ${sql}`).all();
    if (!options?.simple) return rows;
    const first = rows[0];
    if (!first || typeof first !== "object") return undefined;
    return Object.values(first as Record<string, unknown>)[0];
  }

  /** 创建同步事务；限定入口可要求真实最外层 IMMEDIATE，普通嵌套仍使用 SAVEPOINT。 */
  transaction<T extends (...args: any[]) => any>(fn: T, options?: SqliteTransactionOptions): T {
    const db = this;
    return function sqliteTransaction(this: unknown, ...args: Parameters<T>): ReturnType<T> {
      return db.runTransaction(() => fn.apply(this, args), options);
    } as T;
  }

  /** 幂等关闭底层连接，保持旧驱动允许重复 cleanup 的兼容语义。 */
  close(): void {
    if (this.closed) return;
    this.inner.close();
    this.closed = true;
    this.statements.clear();
  }

  /** 运行时安装许可断言，既有 prepared statement 同样受约束。 */
  setAccessGuard(guard: (() => void) | null): void { this.accessGuard = guard; }

  /** 每次实际 SQLite 操作都复核当前同步许可。 */
  private assertAccess(): void { this.accessGuard?.(); }

  /** 写锁模式只能在最外层选择；EXCLUSIVE 在回调前同时排除独立读连接。 */
  private runTransaction<T>(fn: () => T, options?: SqliteTransactionOptions): T {
    this.assertAccess();
    if (this.transactionDepth > 0 && options?.requireOutermost) {
      throw Object.assign(new Error("SQLITE_TRANSACTION_ALREADY_ACTIVE"), { code: "SQLITE_TRANSACTION_ALREADY_ACTIVE" });
    }
    if (this.transactionDepth > 0 && options?.mode && options.mode !== "deferred") {
      throw Object.assign(new Error("SQLITE_TRANSACTION_MODE_NESTED"), { code: "SQLITE_TRANSACTION_MODE_NESTED" });
    }
    const savepoint = this.transactionDepth > 0 ? `cf_tx_${++this.savepointSeq}` : null;
    this.inner.exec(savepoint ? `SAVEPOINT ${savepoint}` : options?.mode === "exclusive" ? "BEGIN EXCLUSIVE" : options?.mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.inner.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.rollbackTransaction(savepoint, error);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  /** 回滚事务；回滚失败时保留业务与回滚的原始错误对象，交所属边界记录。 */
  private rollbackTransaction(savepoint: string | null, originalError: unknown): void {
    try {
      if (savepoint) {
        this.inner.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.inner.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else {
        this.inner.exec("ROLLBACK");
      }
    } catch (rollbackError) {
      throw Object.assign(new AggregateError([originalError, rollbackError], "SQLITE_TRANSACTION_ROLLBACK_FAILED", {
        cause: originalError,
      }), {
        code: "SQLITE_TRANSACTION_ROLLBACK_FAILED",
      });
    }
  }
}

class NodeSqliteStatement implements SqliteStatement {
  /** 保存底层 StatementSync，并启用无前缀命名参数兼容。 */
  constructor(private readonly inner: StatementSync, private readonly assertAccess: () => void) {
    this.inner.setAllowBareNamedParameters(true);
  }

  /** 查询单行并转换为普通对象。 */
  get(...params: unknown[]): unknown {
    this.assertAccess();
    return normalizeRow((this.inner as any).get(...normalizeParams(params)));
  }

  /** 查询多行并转换为普通对象。 */
  all(...params: unknown[]): unknown[] {
    this.assertAccess();
    return ((this.inner as any).all(...normalizeParams(params)) as unknown[]).map(normalizeRow);
  }

  /** 执行写入语句并返回 changes / lastInsertRowid。 */
  run(...params: unknown[]): SqliteRunResult {
    this.assertAccess();
    return (this.inner as any).run(...normalizeParams(params)) as SqliteRunResult;
  }

  /** 流式遍历查询结果并转换每一行。 */
  *iterate(...params: unknown[]): IterableIterator<unknown> {
    this.assertAccess();
    for (const row of (this.inner as any).iterate(...normalizeParams(params)) as Iterable<unknown>) {
      this.assertAccess();
      yield normalizeRow(row);
    }
  }
}

/** 只读或显式 fileMustExist 打开前检查文件，禁止意外创建空库。 */
function assertExistingSqliteFile(filename: string, options?: SqliteOpenOptions): void {
  if (options?.readonly !== true && options?.fileMustExist !== true) return;
  if (fs.existsSync(filename)) return;
  const error = new Error("SQLite database file does not exist") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}

/** 限定 SQLite busy_timeout，避免异常配置造成无限等待。 */
function normalizeBusyTimeoutMs(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  return Math.min(60_000, Math.max(0, Math.trunc(numberValue)));
}

/** 规整绑定参数；SQLite 不接受 boolean，统一转为 1/0。 */
function normalizeParams(params: unknown[]): unknown[] {
  if (params.length === 1 && isNamedParams(params[0])) {
    return [Object.fromEntries(
      Object.entries(params[0] as Record<string, unknown>).map(([key, value]) => [key, normalizeParam(value)]),
    )];
  }
  return params.map(normalizeParam);
}

/** 规整单个绑定值；保持旧驱动把 undefined 作为 SQL NULL 的兼容语义。 */
function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

/** 判断是否为 named-parameter 对象。 */
function isNamedParams(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && !Buffer.isBuffer(value)
      && !(value instanceof Uint8Array),
  );
}

/** 把 null prototype 行转换为普通对象，并把 BLOB 恢复为 Buffer。 */
function normalizeRow(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row) || Buffer.isBuffer(row)) return row;
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [
      key,
      value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value,
    ]),
  );
}
