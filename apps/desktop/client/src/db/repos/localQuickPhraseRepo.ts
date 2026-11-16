import { randomUUID } from "node:crypto";
import type { QuickPhrase, QuickPhraseCollection } from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

/** 本机领域错误交给桌面请求边界翻译并记录一次。 */
export class LocalQuickPhraseError extends Error {
  /** 仅明确的输入或并发冲突允许转换为 4xx。 */
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}

export class LocalQuickPhraseRepo {
  /** 只接收应用库，不读取账号缓存或工作区库。 */
  constructor(private readonly db: SqliteDb) {}

  /** 在同一 SQLite 快照读取集合修订和完整顺序。 */
  list(): QuickPhraseCollection {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT revision FROM local_quick_phrase_collection WHERE id = 1").get() as { revision: number } | undefined;
      if (!row) throw new Error("LOCAL_QUICK_PHRASE_COLLECTION_MISSING");
      const items = this.db.prepare(`SELECT id, title, content, sort_order AS sortOrder, version,
        created_at AS createdAt, updated_at AS updatedAt FROM local_quick_phrases ORDER BY sort_order, id`).all() as QuickPhrase[];
      return { revision: row.revision, items };
    })();
  }

  /** 幂等新增并原子推进集合修订；同请求异内容显式冲突。 */
  create(input: Record<string, unknown>): QuickPhraseCollection {
    const requestId = bounded(input.clientRequestId, 100, "创建请求标识");
    const title = bounded(input.title, 50, "名称"), content = bounded(input.content, 8_000, "内容");
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT title, content FROM local_quick_phrases WHERE create_request_id = ?").get(requestId) as { title: string; content: string } | undefined;
      if (previous) {
        if (previous.title !== title || previous.content !== content) throw new LocalQuickPhraseError(409, "创建请求标识已用于其他内容");
        return this.list();
      }
      const current = this.list();
      if (current.items.length >= 200) throw new LocalQuickPhraseError(409, "本机最多保存 200 条常用提示词");
      const now = Date.now();
      this.db.prepare(`INSERT INTO local_quick_phrases(id, create_request_id, title, content, sort_order, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(`qp_${randomUUID()}`, requestId, title, content, current.items.length, now, now);
      return this.bumpRevision();
    }, { mode: "immediate" })();
  }

  /** 仅当前版本可更新正文，失败事务不改集合修订。 */
  update(input: Record<string, unknown>): QuickPhraseCollection {
    const id = bounded(input.id, 100, "常用提示词 ID"), title = bounded(input.title, 50, "名称");
    const content = bounded(input.content, 8_000, "内容"), version = requiredVersion(input.version);
    return this.db.transaction(() => {
      const result = this.db.prepare("UPDATE local_quick_phrases SET title = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
        .run(title, content, Date.now(), id, version);
      if (Number(result.changes) !== 1) throw new LocalQuickPhraseError(409, "常用提示词已被修改或删除，请刷新后重试");
      return this.bumpRevision();
    }, { mode: "immediate" })();
  }

  /** 版本校验删除，并压紧剩余顺序而不改变正文版本。 */
  delete(input: Record<string, unknown>): QuickPhraseCollection {
    const id = bounded(input.id, 100, "常用提示词 ID"), version = requiredVersion(input.version);
    return this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM local_quick_phrases WHERE id = ? AND version = ?").run(id, version);
      if (Number(result.changes) !== 1) throw new LocalQuickPhraseError(409, "常用提示词已被修改或删除，请刷新后重试");
      this.writeOrder(this.list().items.map(item => item.id));
      return this.bumpRevision();
    }, { mode: "immediate" })();
  }

  /** 完整排序必须匹配集合修订，拒绝漏项、重复和未知身份。 */
  reorder(input: Record<string, unknown>): QuickPhraseCollection {
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || !Array.isArray(input.ids)) throw new LocalQuickPhraseError(400, "排序参数无效");
    const ids = input.ids as unknown[];
    return this.db.transaction(() => {
      const current = this.list();
      if (current.revision !== input.revision) throw new LocalQuickPhraseError(409, "常用提示词顺序已变化，请刷新后重试");
      const unique = new Set(ids);
      if (unique.size !== ids.length || ids.length !== current.items.length || current.items.some(item => !unique.has(item.id))) {
        throw new LocalQuickPhraseError(400, "排序列表必须包含全部常用提示词且不能重复");
      }
      this.writeOrder(ids as string[]);
      return this.bumpRevision();
    }, { mode: "immediate" })();
  }

  /** 只调整位置及更新时间，保持正文乐观锁语义。 */
  private writeOrder(ids: string[]): void {
    const update = this.db.prepare("UPDATE local_quick_phrases SET sort_order = ?, updated_at = ? WHERE id = ? AND sort_order <> ?");
    const now = Date.now();
    ids.forEach((id, index) => update.run(index, now, id, index));
  }

  /** 在调用方写事务内推进修订并返回权威结果。 */
  private bumpRevision(): QuickPhraseCollection {
    this.db.prepare("UPDATE local_quick_phrase_collection SET revision = revision + 1 WHERE id = 1").run();
    return this.list();
  }
}

/** 与账号常用提示词保持相同的 Unicode 长度及去空白规则。 */
function bounded(value: unknown, max: number, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Array.from(text).length > max) throw new LocalQuickPhraseError(400, `${label}长度必须为 1-${max} 个字符`);
  return text;
}

/** 版本必须是正安全整数，拒绝缺失和隐式类型转换。 */
function requiredVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new LocalQuickPhraseError(400, "版本参数无效");
  return value;
}
