import { createHash } from "node:crypto";
import path from "node:path";
import { sameIdentity, type ProcessIdentity } from "./windowsProcessIdentity.js";

export type ShellProcessRelease = { revision: number; observerKey: string; snapshotSha256: string };
export type ShellProcessLifecycle = { key: string; parentKey: string; release: ShellProcessRelease | null };
export type ShellProcessInventory = { owned: ProcessIdentity[]; lifecycle: ShellProcessLifecycle[] };
type Observation = { inventory: ShellProcessInventory; roots: readonly ProcessIdentity[]; processes: readonly ProcessIdentity[];
  observer: ProcessIdentity; revision: number; knownOwned?: readonly ProcessIdentity[]; excluded?: readonly ProcessIdentity[] };
const MAX_OWNED = 1024;
type ObservationFailure = "OBSERVER_UNAVAILABLE" | "ACTIVE_IDENTITY_CHANGED" | "RELEASED_IDENTITY_REAPPEARED"
  | "RELEASED_IDENTITY_INVALID" | "UNKNOWN_PARENT_MISSING" | "CHILD_PREDATES_PARENT" | "CHILD_ROLE_CONFLICT"
  | "RELATED_IDENTITY_INVALID" | "CHILD_IDENTITY_INVALID";

/** 五字段原样编码实例身份；不以 PID 或正规化路径代替完整身份。 */
export function processInstanceKey(identity: ProcessIdentity): string {
  const value = readIdentity(identity);
  return digest([value.pid, value.parentPid, value.created, value.executable, value.commandLine]);
}

/** 严格复制单一库存及其逐项元数据，验证父实例图和释放证明范围。 */
export function readProcessInventory(ownedInput: unknown, lifecycleInput: unknown, rootInput: readonly ProcessIdentity[], revision: number): ShellProcessInventory {
  integer(revision, 1);
  const roots = identities(rootInput), owned = identities(ownedInput, true), metadata = array(lifecycleInput);
  if (owned.length !== metadata.length) invalid();
  const keys = new Map(roots.map(root => [processInstanceKey(root), root])), rootPids = new Set(roots.map(root => root.pid));
  const seen = new Set<string>(), activePids = new Set<number>();
  const lifecycle = metadata.map((input, index): ShellProcessLifecycle => {
    const value = fields(input, ["key", "parentKey", "release"]), key = hash(value.key), parentKey = hash(value.parentKey), identity = owned[index]!;
    if (key !== processInstanceKey(identity) || seen.has(key) || rootPids.has(identity.pid)) invalid();
    seen.add(key); keys.set(key, identity);
    let release: ShellProcessRelease | null = null;
    if (value.release !== null) {
      const released = fields(value.release, ["revision", "observerKey", "snapshotSha256"]), releaseRevision = integer(released.revision, 1);
      const observerKey = hash(released.observerKey);
      if (releaseRevision > revision || !roots.some(root => processInstanceKey(root) === observerKey)) invalid();
      release = { revision: releaseRevision, observerKey, snapshotSha256: hash(released.snapshotSha256) };
    } else {
      if (activePids.has(identity.pid)) invalid();
      activePids.add(identity.pid);
    }
    return { key, parentKey, release };
  });
  const byKey = new Map(lifecycle.map(item => [item.key, item]));
  for (let index = 0; index < owned.length; index++) {
    const identity = owned[index]!, item = lifecycle[index]!, parent = keys.get(item.parentKey);
    if (!parent || parent.pid !== identity.parentPid || identity.created < parent.created) invalid();
    const visited = new Set([item.key]);
    let ancestor = byKey.get(item.parentKey);
    while (ancestor) {
      if (visited.has(ancestor.key)) invalid();
      visited.add(ancestor.key);
      if (ancestor.release && (!item.release || item.release.revision > ancestor.release.revision)) invalid();
      ancestor = byKey.get(ancestor.parentKey);
    }
  }
  return { owned, lifecycle };
}

/** 首次交接保留唯一 PID 历史图，再由同次完整成功快照证明初始释放。 */
export function createProcessInventory(input: { owned: readonly ProcessIdentity[]; roots: readonly ProcessIdentity[];
  processes: readonly ProcessIdentity[]; observer: ProcessIdentity; revision: number }): ShellProcessInventory {
  const roots = identities(input.roots), owned = identities(input.owned, true), known = [...roots, ...owned];
  if (new Set(known.map(identity => identity.pid)).size !== known.length) invalid();
  const lifecycle = owned.map(identity => {
    const parent = known.find(value => value.pid === identity.parentPid);
    if (!parent || parent.created > identity.created) invalid();
    return { key: processInstanceKey(identity), parentKey: processInstanceKey(parent), release: null };
  });
  return observeProcessInventory({ ...input, roots, inventory: readProcessInventory(owned, lifecycle, roots, input.revision) });
}

/** 仅投影未释放普通实例；完整历史仍留在同一库存。 */
export function activeProcessInventory(inventory: ShellProcessInventory): ProcessIdentity[] {
  return inventory.owned.filter((_, index) => inventory.lifecycle[index]!.release === null).map(identity => ({ ...identity }));
}

/** 完整观察仅认领当前父链；缺父旧行须早于全部父代，具体子树全失后才释放。 */
export function observeProcessInventory(input: Observation): ShellProcessInventory {
  const roots = identities(input.roots), processes = snapshot(input.processes), excluded = identities(input.excluded ?? []);
  const inventory = readProcessInventory(input.inventory.owned, input.inventory.lifecycle, roots, input.revision);
  const required = activeProcessInventory(inventory);
  const observer = readIdentity(input.observer);
  if (!roots.some(root => sameIdentity(root, observer)) || !processes.some(item => sameIdentity(item, observer))) observationInvalid("OBSERVER_UNAVAILABLE", observer);
  assertSnapshot(inventory, roots, processes, excluded);
  const owned = inventory.owned, lifecycle = inventory.lifecycle, actual = new Map(processes.map(item => [item.pid, item]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of processes) {
      if ([...roots, ...owned, ...excluded].some(item => sameIdentity(item, identity))) continue;
      const parents = [...roots, ...activeProcessInventory({ owned, lifecycle })];
      const parent = parents.find(item => item.pid === identity.parentPid);
      if (!parent || excluded.some(item => item.pid === parent.pid)) continue;
      if (!actual.has(parent.pid)) {
        if ([...roots, ...excluded].some(item => item.pid === identity.pid)) observationInvalid("CHILD_ROLE_CONFLICT", identity);
        if (predatesAllParents(identity, [...roots, ...owned])) continue;
        observationInvalid("UNKNOWN_PARENT_MISSING", identity);
      }
      if (!sameIdentity(actual.get(parent.pid)!, parent)) observationInvalid("UNKNOWN_PARENT_MISSING", identity);
      if ([...roots, ...excluded].some(item => item.pid === identity.pid)) observationInvalid("CHILD_ROLE_CONFLICT", identity);
      if (predatesAllParents(identity, [...roots, ...owned])) continue;
      const child = observedIdentity(identity, "CHILD_IDENTITY_INVALID");
      if (child.created < parent.created) observationInvalid("CHILD_PREDATES_PARENT", child);
      if (owned.length >= MAX_OWNED) capacity();
      owned.push(child); lifecycle.push({ key: processInstanceKey(child), parentKey: processInstanceKey(parent), release: null }); changed = true;
    }
  }
  if (input.knownOwned) {
    const supplied = identities(input.knownOwned, true);
    if (required.some(identity => !supplied.some(item => sameIdentity(identity, item)))
      || supplied.some(identity => !owned.some(item => sameIdentity(identity, item)))) invalid();
  }
  assertSnapshot({ owned, lifecycle }, roots, processes, excluded);
  const snapshotSha256 = digest([...processes].sort((left, right) => left.pid - right.pid)
    .map(item => [item.pid, item.parentPid, item.created, item.executable, item.commandLine]));
  /** 父释放要求所有普通后代同时缺席；角色根不进入普通子树。 */
  function absent(index: number, visiting = new Set<number>()): boolean {
    if (visiting.has(index)) invalid();
    if (lifecycle[index]!.release) return true;
    if (actual.has(owned[index]!.pid)) return false;
    visiting.add(index);
    const result = lifecycle.every((item, childIndex) => item.parentKey !== lifecycle[index]!.key || absent(childIndex, visiting));
    visiting.delete(index); return result;
  }
  const releasable = lifecycle.map((item, index) => item.release === null && absent(index));
  for (let index = 0; index < lifecycle.length; index++) if (releasable[index]) {
    lifecycle[index] = { ...lifecycle[index]!, release: { revision: input.revision, observerKey: processInstanceKey(observer), snapshotSha256 } };
  }
  return readProcessInventory(owned, lifecycle, roots, input.revision);
}

/** 释放核验仍严格约束角色和未释放库存，既有证明允许无关的新 PID 实例存在。 */
export function assertProcessInventoryReleased(input: { inventory: ShellProcessInventory; roots: readonly ProcessIdentity[];
  processes: readonly ProcessIdentity[]; excluded?: readonly ProcessIdentity[] }): void {
  const processes = snapshot(input.processes), roots = identities(input.roots), excluded = identities(input.excluded ?? []);
  assertSnapshot(input.inventory, roots, processes, excluded);
  for (const identity of [...roots, ...activeProcessInventory(input.inventory)]) {
    if (excluded.some(item => sameIdentity(item, identity))) continue;
    if (processes.some(item => item.pid === identity.pid)) invalid();
  }
}

/** 查询前只读核完整历史；仅返回活父链下文本字段暂缺的新行，不认领或释放。 */
export function preflightProcessInventory(input: { inventory: ShellProcessInventory; roots: readonly ProcessIdentity[];
  processes: readonly ProcessIdentity[]; revision: number; known: readonly ProcessIdentity[]; excluded?: readonly ProcessIdentity[] }): readonly ProcessIdentity[] {
  const roots = identities(input.roots), known = identities(input.known), processes = snapshot(input.processes), excluded = identities(input.excluded ?? []);
  const inventory = readProcessInventory(input.inventory.owned, input.inventory.lifecycle, roots, input.revision), pending: ProcessIdentity[] = [];
  for (const original of known) {
    const actual = processes.find(item => item.pid === original.pid);
    if (actual && !sameVisibleIdentity(actual, original)) observationInvalid("ACTIVE_IDENTITY_CHANGED", actual);
  }
  assertSnapshot(inventory, roots, processes, excluded, { known, pending });
  const complete: ProcessIdentity[] = [], active = [...roots, ...activeProcessInventory(inventory)], historical = [...roots, ...inventory.owned];
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of processes) {
      if ([...historical, ...complete, ...excluded].some(item => sameIdentity(item, child))
        || known.some(item => !sameIdentity(child, item) && sameVisibleIdentity(child, item)) || pending.some(item => item.pid === child.pid)) continue;
      const parent = [...active, ...complete].find(item => item.pid === child.parentPid);
      if (!parent || !processes.some(item => sameIdentity(item, parent)) || excluded.some(item => item.pid === parent.pid)) continue;
      if ([...roots, ...excluded].some(item => item.pid === child.pid)) observationInvalid("CHILD_ROLE_CONFLICT", child);
      if (predatesAllParents(child, [...historical, ...complete])) continue;
      const identity = observedIdentity(child, "CHILD_IDENTITY_INVALID");
      if (identity.created < parent.created) observationInvalid("CHILD_PREDATES_PARENT", identity);
      if (inventory.owned.length + complete.length >= MAX_OWNED) capacity();
      complete.push(identity); changed = true;
    }
  }
  assertSnapshot(inventory, roots, processes, excluded, { known, pending: [], complete });
  return pending;
}

/** 可见字段仍须逐字一致；暂缺字段只供原known重查，不拼成完整实例。 */
function sameVisibleIdentity(actual: ProcessIdentity, known: ProcessIdentity): boolean {
  return actual.pid === known.pid && actual.parentPid === known.parentPid && actual.created === known.created
    && (!actual.executable || actual.executable === known.executable) && (!actual.commandLine || actual.commandLine === known.commandLine);
}

/** 校验相关父完整性与历史孤儿；缺父时仅排除早于全部父代且无角色冲突的旧行。 */
function assertSnapshot(inventory: ShellProcessInventory, roots: readonly ProcessIdentity[], processes: ProcessIdentity[], excluded: ProcessIdentity[],
  preflight?: { known: ProcessIdentity[]; pending: ProcessIdentity[]; complete?: ProcessIdentity[] }): void {
  const known = [...roots, ...inventory.owned, ...(preflight?.complete ?? [])], active = [...roots, ...activeProcessInventory(inventory)];
  for (const identity of active) {
    const actual = processes.find(item => item.pid === identity.pid);
    if (actual && !sameIdentity(actual, identity)
      && !(preflight?.known.some(item => sameIdentity(item, identity)) && sameVisibleIdentity(actual, identity))) observationInvalid("ACTIVE_IDENTITY_CHANGED", actual);
  }
  for (let index = 0; index < inventory.owned.length; index++) {
    if (!inventory.lifecycle[index]!.release) continue;
    const historical = inventory.owned[index]!, actual = processes.find(item => item.pid === historical.pid);
    if (actual) {
      observedIdentity(actual, "RELEASED_IDENTITY_INVALID");
      if (sameIdentity(actual, historical)) observationInvalid("RELEASED_IDENTITY_REAPPEARED", actual);
      if (actual.created <= historical.created || historical.commandLine && !actual.commandLine) observationInvalid("RELEASED_IDENTITY_INVALID", actual);
    }
  }
  for (const child of processes) {
    if ([...known, ...excluded].some(item => sameIdentity(item, child))
      || preflight?.known.some(item => sameVisibleIdentity(child, item)) || !known.some(item => item.pid === child.parentPid)) continue;
    const parent = processes.find(item => item.pid === child.parentPid);
    if (!parent) {
      if ([...roots, ...excluded].some(item => item.pid === child.pid)) observationInvalid("CHILD_ROLE_CONFLICT", child);
      if (predatesAllParents(child, known)) continue;
      observationInvalid("UNKNOWN_PARENT_MISSING", child);
    }
    const knownPartialParent = preflight?.known.some(item => sameVisibleIdentity(parent, item));
    if (!knownPartialParent) observedIdentity(parent, "RELATED_IDENTITY_INVALID");
    if ([...roots, ...excluded].some(item => item.pid === child.pid)) observationInvalid("CHILD_ROLE_CONFLICT", child);
    if (predatesAllParents(child, known)) continue;
    if (child.created < parent.created) observationInvalid("CHILD_PREDATES_PARENT", child);
    // 新子进程刚出现时两个文本字段都可能暂缺；父实例和创建时间仍必须完整稳定。
    if (preflight && child.pid > 0 && child.created > 0 && (!child.executable || !child.commandLine)
      && ![...known, ...excluded, ...preflight.known].some(item => item.pid === child.pid)
      && active.some(item => sameIdentity(item, parent))) {
      preflight.pending.push({ ...child }); continue;
    }
    observedIdentity(child, "RELATED_IDENTITY_INVALID");
  }
}

/** 未登记行须正创建时间严格早于同PID全部父代，空集合不能证明不归属。 */
function predatesAllParents(identity: ProcessIdentity, known: readonly ProcessIdentity[]): boolean {
  const parents = known.filter(item => item.pid === identity.parentPid);
  return identity.created > 0 && parents.length > 0 && parents.every(parent => identity.created < parent.created);
}

/** 系统快照允许系统行不可见字段，相关行在归属边界再严格检查。 */
function snapshot(input: unknown): ProcessIdentity[] {
  const values = array(input);
  if (!values.length || values.length > 65536) invalid();
  const result = values.map(value => readIdentity(value, true));
  if (new Set(result.map(item => item.pid)).size !== result.length) invalid();
  return result;
}

/** 库存可保留同 PID 多代身份，实例 key 不可重复。 */
function identities(input: unknown, bounded = false): ProcessIdentity[] {
  const values = array(input);
  if (bounded && values.length > MAX_OWNED) capacity();
  const result = values.map(value => readIdentity(value));
  if (new Set(result.map(processInstanceKey)).size !== result.length) invalid();
  return result;
}

/** 仅复制自有数据字段，拒绝访问器、自定义原型和未知键。 */
function fields(input: unknown, expected: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    result[key as string] = descriptor.value;
  }
  return result;
}

/** 数组不接受空洞、自定义属性或访问器。 */
function array(input: unknown): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    return descriptor.value;
  });
}

/** 普通身份必须完整规范；系统行保留原始绝对路径，相关身份在归属边界再严格校验。 */
function readIdentity(input: unknown, system = false): ProcessIdentity {
  const value = fields(input, ["pid", "parentPid", "created", "executable", "commandLine"]);
  const pid = integer(value.pid, system ? 0 : 1), parentPid = integer(value.parentPid, 0), created = integer(value.created, system ? 0 : 1);
  if ((!system && pid === parentPid) || typeof value.executable !== "string" || typeof value.commandLine !== "string"
    || value.commandLine.length > 32768 || value.commandLine.includes("\0") || value.executable.includes("\0")
    || value.executable.length > 4096 || Buffer.from(value.commandLine, "utf8").toString("utf8") !== value.commandLine
    || Buffer.from(value.executable, "utf8").toString("utf8") !== value.executable
    || !(system && value.executable === "") && (!path.isAbsolute(value.executable)
      || !system && path.resolve(value.executable) !== value.executable)) invalid();
  return { pid, parentPid, created, executable: value.executable, commandLine: value.commandLine };
}

/** 计数必须可精确表达，不能隐式转换字符串。 */
function integer(input: unknown, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) invalid();
  return input;
}
/** 摘要采用固定小写 SHA256。 */
function hash(input: unknown): string { if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) invalid(); return input; }
/** 固定 JSON 编码摘要仅用于证据一致性。 */
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
/** 运行快照的严格身份失败保留原原因，同时定位既有读取位置。 */
function observedIdentity(identity: ProcessIdentity, reason: ObservationFailure): ProcessIdentity {
  try { return readIdentity(identity); }
  catch (cause) { observationInvalid(reason, identity, cause); }
}
/** 观察失败只携固定原因与安全实例摘要，必要时保留原严格校验错误。 */
function observationInvalid(reason: ObservationFailure, identity: ProcessIdentity, cause?: unknown): never {
  const inventoryFailure = { reason, pid: identity.pid, parentPid: identity.parentPid, created: identity.created,
    instanceSha256: digest([identity.pid, identity.parentPid, identity.created, identity.executable, identity.commandLine]) };
  throw Object.assign(new Error("DESKTOP_SHELL_PROCESS_INVENTORY_INVALID", cause === undefined ? undefined : { cause }), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID", inventoryFailure });
}
/** 畸形事实显式交由原业务边界处理。 */
function invalid(): never { throw Object.assign(new Error("DESKTOP_SHELL_PROCESS_INVENTORY_INVALID"), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID" }); }
/** 历史到达固定上限后失败，禁止裁剪。 */
function capacity(): never { throw Object.assign(new Error("DESKTOP_SHELL_PROCESS_INVENTORY_CAPACITY"), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_CAPACITY" }); }
