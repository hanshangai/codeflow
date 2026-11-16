import type { OrchAssetDefinitionKind } from "@codeflowai/shared";

/** 排序只依赖 kind，因此用最小结构契约表达输入，便于单测构造夹具与跨模块复用。 */
export type BuiltinFirstSortable = {
  kind?: OrchAssetDefinitionKind | null;
};

/**
 * 把内置条目稳定地排到非内置条目之前。
 *
 * 用「分区拼接」而不是 Array#sort：结果只由 kind 决定，两段内部都完整保留上游给出的相对顺序，
 * 不引入名称、版本或更新时间等次级排序键，也不修改传入数组。
 */
export function sortBuiltinFirst<T extends BuiltinFirstSortable>(items: readonly T[]): T[] {
  const builtin: T[] = [];
  const others: T[] = [];
  for (const item of items) {
    if (item?.kind === "builtin") builtin.push(item);
    else others.push(item);
  }
  return [...builtin, ...others];
}
