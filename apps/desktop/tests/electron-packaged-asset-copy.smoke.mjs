import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error("用法：electron-packaged-asset-copy.smoke.mjs <exe> <不存在的仓库外报告目录>");
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const root = path.resolve(output);
const expectedClientHash = "5a8b8d5b983d6f9212474ef865daea4bb582116e6f0c93873f5b849689d5e163";
const report = { requestId: randomUUID(), status: "running", phase: "preflight", root, runs: [], requests: [],
  scope: "windows_packaged_asset_copy_atomicity", paidProviderExercised: false };
const observedPids = new Set();
const assetTables = ["orch_knowledge_bundles", "orch_toolsets", "orch_skills", "orch_roles", "orch_workflows", "orch_skill_files"];
const collections = [["knowledgeBundles", "bundles", "knowledge"], ["toolsets", "toolsets", "toolset"],
  ["skills", "skills", "skill"], ["roles", "roles", "role"], ["workflows", "workflows", "workflow"]];
const marker = `D17L_COPY_WRITE_REJECTED_${report.requestId}`;
const triggerName = "d17l_asset_copy_failure";
let application, child, page, electron, env;

/** 外部操作限时；成功、失败和超时都释放计时器。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 真实输入和证据目录必须离开仓库，防止 junction 逃回源码树。 */
function outsideRepository(target) {
  const relative = path.relative(repository, target);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_ASSET_COPY_OUTSIDE_REPOSITORY_REQUIRED");
}

/** 工件和证据双向不包含；必须在任何 mkdir 之前检查。 */
function assertDisjoint(artifact, evidence) {
  for (const [parent, target] of [[artifact, evidence], [evidence, artifact]]) {
    const relative = path.relative(parent, target);
    assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_ASSET_COPY_ARTIFACT_OUTPUT_OVERLAP");
  }
}

/** 四项输入指纹覆盖实际 exe、ASAR、Client 和 Web，不写输入工件。 */
async function artifactHashes(executable) {
  const resources = path.join(path.dirname(executable), "resources");
  const files = { exe: executable, asar: path.join(resources, "app.asar"), client: path.join(resources, "client/dist/index.cjs"),
    web: path.join(resources, "web/index.html") };
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, filename]) =>
    [key, createHash("sha256").update(await bounded(fs.readFile(filename), 30_000, "DESKTOP_ASSET_COPY_HASH_TIMEOUT")).digest("hex")])));
}

outsideRepository(root);
const actualRoot = path.join(await bounded(fs.realpath(path.dirname(root)), 5_000, "DESKTOP_ASSET_COPY_OUTPUT_PATH_TIMEOUT"), path.basename(root));
outsideRepository(actualRoot);
const executable = await bounded(fs.realpath(path.resolve(input)), 5_000, "DESKTOP_ASSET_COPY_EXE_TIMEOUT");
outsideRepository(executable);
assertDisjoint(path.dirname(executable), actualRoot);
assert.equal(process.platform, "win32", "DESKTOP_ASSET_COPY_WINDOWS_REQUIRED");
assert.equal(path.extname(executable).toLowerCase(), ".exe", "DESKTOP_ASSET_COPY_EXE_REQUIRED");
report.artifactBefore = await artifactHashes(executable);
assert.equal(report.artifactBefore.client, expectedClientHash, "DESKTOP_ASSET_COPY_CLIENT_HASH_MISMATCH");
await bounded(fs.mkdir(root), 5_000, "DESKTOP_ASSET_COPY_OUTPUT_MKDIR_TIMEOUT");
const reportPath = path.join(root, "verification.json");
const databasePath = path.join(root, "runtime/codeflowai.db");

/** 只有 ESRCH 可证明退出；查询未知必须保留根因并失败。 */
function processState(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "DESKTOP_ASSET_COPY_INVALID_PID");
  try { process.kill(pid, 0); return { pid, state: "alive" }; }
  catch (error) { return error.code === "ESRCH" ? { pid, state: "absent" } : { pid, state: "unknown", error: failure(error) }; }
}

/** 查询本轮直接观测进程，禁止用历史 PID 清理后续进程。 */
function processFacts() { return [...observedPids].map(processState); }

/** 有界轮询真实条件，异常直接终止，不把查询失败当作未就绪。 */
async function waitUntil(predicate, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await bounded(Promise.resolve().then(predicate), Math.max(1, deadline - Date.now()), code)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

/** 用户目录和 PATH 全部隔离，未安装 provider，不继承任何模型凭据。 */
async function isolatedEnvironment() {
  const allowed = /^(?:pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i;
  const result = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot, "DESKTOP_ASSET_COPY_SYSTEM_ROOT_REQUIRED");
  const bin = path.join(root, "bin");
  await bounded(fs.mkdir(bin), 5_000, "DESKTOP_ASSET_COPY_ISOLATION_TIMEOUT");
  result.PATH = [bin, path.join(systemRoot, "System32"), systemRoot].join(path.delimiter);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMP", "TEMP", "TMPDIR"]) {
    result[key] = path.join(root, key.toLowerCase());
    await bounded(fs.mkdir(result[key]), 5_000, "DESKTOP_ASSET_COPY_ISOLATION_TIMEOUT");
  }
  result.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return result;
}

/** 原受限桥是唯一业务入口；预期失败也必须核对 HTTP 状态和正文。 */
async function request(method, body = {}, status = 200) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, body }),
    35_000, `DESKTOP_ASSET_COPY_REQUEST_TIMEOUT: ${method}`);
  report.requests.push({ phase: report.phase, method, body, response });
  assert.equal(response.status, status, `${method}: ${JSON.stringify(response)}`);
  assert.equal(response.body?.ok, status === 200, `${method}: ${JSON.stringify(response)}`);
  return response.body;
}

/** 记录 Electron 直接提供的进程清单，不扫描机器上其他进程。 */
async function collectProcesses() {
  const pids = await bounded(application.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid)),
    10_000, "DESKTOP_ASSET_COPY_METRICS_TIMEOUT");
  for (const pid of pids) {
    assert.equal(processState(pid).state, "alive", "DESKTOP_ASSET_COPY_METRIC_PID_UNCONFIRMED");
    observedPids.add(pid);
  }
  return pids;
}

/** 实际 exe 必须满足隔离目录、原沙箱和数据库就绪合同。 */
async function launch(attempt) {
  assert.equal(observedPids.size, 0, "DESKTOP_ASSET_COPY_PREVIOUS_RUN_ACTIVE");
  application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(root, "profile")}`], env, cwd: root, timeout: 60_000 });
  child = application.process();
  assert.equal(processState(child.pid).state, "alive"); observedPids.add(child.pid);
  const run = { attempt, pid: child.pid, stderr: "", rendererErrors: [] }; report.runs.push(run);
  child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
  page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(30_000);
  page.on("pageerror", error => run.rendererErrors.push(failure(error)));
  page.on("console", message => { if (message.type() === "error") run.rendererErrors.push({ name: "ConsoleError", message: message.text() }); });
  await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
  await page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
  run.facts = await bounded(application.evaluate(({ app, BrowserWindow }) => {
    const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { packaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, userData: app.getPath("userData"),
      preferences: { sandbox, contextIsolation, nodeIntegration }, path: process.env.PATH, nodeOptions: process.env.NODE_OPTIONS,
      nodePath: process.env.NODE_PATH, codeflowEnv: Object.keys(process.env).filter(key => key.startsWith("CODEFLOWAI_")) };
  }), 15_000, "DESKTOP_ASSET_COPY_MAIN_FACTS_TIMEOUT");
  assert.equal(run.facts.packaged, true); assert.equal(run.facts.execPath, executable);
  assert.equal(run.facts.appPath, path.join(path.dirname(executable), "resources/app.asar"));
  assert.equal(run.facts.userData, path.join(root, "profile")); assert.equal(run.facts.path, env.PATH);
  assert.equal(run.facts.nodeOptions, undefined); assert.equal(run.facts.nodePath, undefined);
  assert.deepEqual(run.facts.codeflowEnv, ["CODEFLOWAI_DESKTOP_DATA_DIR"]);
  assert.deepEqual(run.facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  run.state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_ASSET_COPY_STATE_TIMEOUT");
  assert.equal(run.state.status, "ready"); assert.equal(run.state.health.database, "ready");
  assert.equal(processState(run.state.pid).state, "alive"); assert.notEqual(run.state.pid, child.pid); observedPids.add(run.state.pid);
  run.metrics = await collectProcesses(); run.clientId = (await request("runtime.info")).client.clientId;
  assert.ok(typeof run.clientId === "string" && run.clientId.trim());
  return run;
}

/** 原退出 IPC 必须正常结束，全部本轮 PID 证实退出后才允许离线写库。 */
async function exit(run) {
  run.finalState = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_ASSET_COPY_FINAL_STATE_TIMEOUT");
  assert.equal(run.finalState.status, "ready"); assert.equal(run.finalState.pid, run.state.pid);
  run.finalMetrics = await collectProcesses();
  await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
    bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_ASSET_COPY_EXIT_TIMEOUT")]);
  await waitUntil(() => {
    const facts = processFacts();
    assert.ok(facts.every(item => item.state !== "unknown"), `DESKTOP_ASSET_COPY_PID_UNKNOWN: ${JSON.stringify(facts)}`);
    return facts.every(item => item.state === "absent");
  }, 5_000, "DESKTOP_ASSET_COPY_PROCESSES_REMAINED");
  run.processes = processFacts(); assert.equal(child.exitCode, 0); assert.deepEqual(run.rendererErrors, []);
  run.exitCode = child.exitCode; application = undefined; child = undefined; page = undefined; observedPids.clear();
}

/** 原错与关闭错同时保留；只在精确数据库路径操作本次独占数据。 */
function withDatabase(readOnly, operation) {
  const db = new DatabaseSync(databasePath, { readOnly, timeout: 5_000 });
  let result, operationError;
  try { result = operation(db); } catch (error) { operationError = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError([...(operationError ? [operationError] : []), error], "DESKTOP_ASSET_COPY_SQLITE_CLOSE_FAILED"); }
  if (operationError) throw operationError;
  return result;
}

/** 六张资产表在同一只读事务中精确取样，保留正文而非只比较计数。 */
function assetSnapshot(workspaceId) {
  return withDatabase(true, db => {
    db.exec("BEGIN");
    const result = Object.fromEntries(assetTables.map(table => [table, table === "orch_skill_files"
      ? db.prepare("SELECT f.* FROM orch_skill_files f JOIN orch_skills s ON s.id=f.skill_id WHERE s.workspace_id=? ORDER BY f.skill_id,f.rel_path").all(workspaceId)
      : db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY id`).all(workspaceId)]));
    db.exec("COMMIT");
    return JSON.parse(JSON.stringify(result));
  });
}

/** 无执行场景必须保持会话、turn、实例及事件证据为零。 */
function assertIdle() {
  return withDatabase(true, db => {
    const counts = Object.fromEntries(["threads", "thread_turns", "orch_instances", "conversation_events", "raw_engine_events", "orch_node_attempts"]
      .map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    assert.ok(Object.values(counts).every(count => count === 0), `DESKTOP_ASSET_COPY_EXECUTION_UNEXPECTED: ${JSON.stringify(counts)}`);
    return counts;
  });
}

/** SQL 值只来自本次 UUID 和 bridge 分配身份，仍按 SQL 字面量转义。 */
function sqlLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }

/** trigger 仅在完整退出后增删，且只拦截唯一工作区的唯一流程副本名。 */
function changeTrigger(install, workspaceId, workflowName) {
  assert.equal(application, undefined, "DESKTOP_ASSET_COPY_OFFLINE_REQUIRED");
  assert.equal(observedPids.size, 0, "DESKTOP_ASSET_COPY_OFFLINE_REQUIRED");
  assert.ok(report.runs.length > 0 && report.runs.every(run => run.exitCode === 0 && run.processes.every(item => item.state === "absent")),
    "DESKTOP_ASSET_COPY_EXIT_EVIDENCE_REQUIRED");
  const sql = `CREATE TRIGGER ${triggerName} BEFORE INSERT ON orch_workflows WHEN NEW.workspace_id=${sqlLiteral(workspaceId)} AND NEW.name=${sqlLiteral(`${workflowName}_复制`)} BEGIN SELECT RAISE(ABORT,${sqlLiteral(marker)}); END`;
  return withDatabase(false, db => {
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName);
    if (install) {
      assert.equal(existing, undefined); db.exec(sql);
      const saved = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName);
      assert.equal(saved.sql, sql); return { installed: true, sql };
    }
    assert.equal(existing?.sql, sql); db.exec(`DROP TRIGGER ${triggerName}`);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName), undefined);
    return { installed: false, sql };
  });
}

/** 五类定义和真实 Skill 包文件均通过原 bridge 新建。 */
async function createAssets(workspaceId) {
  const prefix = `D17l-${report.requestId}`;
  const knowledge = (await request("orch.knowledgeBundles.upsert", { workspaceId, bundle: { name: `${prefix}-knowledge`,
    description: "复制原子性知识", scope: "role", sourceRefs: [], content: "完整依赖正文。" } })).bundle;
  const toolset = (await request("orch.toolsets.upsert", { workspaceId, toolset: { name: `${prefix}-toolset`, description: "复制原子性工具",
    tools: [{ id: "copy-check", name: "复制核验", description: "仅静态复制，不执行", runtime: "prompt", invocationHint: "核验引用", code: "保留完整引用。" }] } })).toolset;
  const skillMd = "# 复制验收技能\n保留 UTF-8 正文。\n";
  const files = [{ relPath: "SKILL.md", kind: "skill-md", contentText: skillMd },
    { relPath: "scripts/check.mjs", kind: "script", contentText: "export const copyEvidence = 1;\n" },
    { relPath: "assets/evidence.bin", kind: "asset", contentBase64: "AAECAw==" }].map(file => {
    const bytes = file.contentText != null ? Buffer.from(file.contentText, "utf8") : Buffer.from(file.contentBase64, "base64");
    return { ...file, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const skill = (await request("orch.skills.upsert", { workspaceId, skill: { name: `${prefix}-skill`, slug: `d17l-${report.requestId}`,
    description: "完整 Skill 文件包", trigger: "copy verification", instructions: "仅复制文件包", targetEngines: ["codex"], skillMd, files,
    scripts: [{ id: "copy-check", name: "Check", description: "static file", scriptPath: "scripts/check.mjs", runtime: "node" }] } })).skill;
  const defaults = await bounded(application.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule("module");
    const shared = createRequire(`${app.getAppPath()}/package.json`)("@codeflowai/shared");
    return { executionConfig: shared.createDefaultRoleExecutionConfig("codex"), inputDefinition: shared.createDefaultRoleInputDefinition(),
      outputDefinition: shared.createDefaultRoleOutputDefinition() };
  }), 10_000, "DESKTOP_ASSET_COPY_DEFAULTS_TIMEOUT");
  const role = (await request("orch.roles.upsert", { workspaceId, role: { ...defaults, name: `${prefix}-role`, description: "完整依赖角色",
    systemPrompt: "静态复制验收，不执行模型调用。", gateCriteria: [], defaultKnowledgeBundleIds: [knowledge.id],
    defaultSkillIds: [skill.id], toolRefs: [{ toolsetId: toolset.id, toolId: "copy-check" }] } })).role;
  const workflow = (await request("orch.workflows.upsert", { workspaceId, workflow: { name: `${prefix}-workflow`, description: "完整图末段写入", version: 1,
    workflowKnowledgeBundleIds: [knowledge.id], nodes: [{ id: "copy", type: "role", label: "复制验收", roleId: role.id,
      knowledgeOverrideBundleIds: [knowledge.id], position: { x: 0, y: 0 } }], edges: [] } })).workflow;
  return { knowledge, toolset, skill, role, workflow };
}

/** 资产列表来自真实业务读取，排除仅响应成功但持久化缺失。 */
async function assetLists(workspaceId) {
  const result = {};
  for (const [collection, field, key] of collections) result[key] = (await request(`orch.${collection}.list`, { workspaceId }))[field];
  return result;
}

/** 失败和重启后只允许原个人图，不能残留任何半份副本。 */
function assertOnlyOriginals(lists, originals) {
  for (const [, , key] of collections) {
    const personal = lists[key].filter(asset => asset.kind === "custom");
    assert.deepEqual(personal, [originals[key]], `DESKTOP_ASSET_COPY_PARTIAL_GRAPH: ${key}`);
  }
}

/** 逐文件重算正文摘要；包摘要按持久合同核对，复制改名后应生成新包摘要。 */
function assertSkill(skill) {
  assert.equal(skill.files.length, 3);
  for (const file of skill.files) {
    const bytes = file.contentText != null ? Buffer.from(file.contentText, "utf8") : Buffer.from(file.contentBase64, "base64");
    assert.equal(file.sizeBytes, bytes.length); assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  const payload = { name: skill.name, slug: skill.slug, description: skill.description, trigger: skill.trigger, instructions: skill.instructions,
    targetEngines: skill.targetEngines, tags: skill.tags ?? [], skillMd: skill.skillMd ?? "", scripts: skill.scripts ?? [], autoInstall: skill.autoInstall === true,
    files: skill.files.map(file => ({ relPath: file.relPath, kind: file.kind, contentType: file.contentType ?? null, sha256: file.sha256 })) };
  assert.equal(skill.packageHash, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
}

/** 完整图只有一套新身份，所有内部引用指向副本，原 Skill 文件正文保持。 */
function assertCopiedGraph(imported, originals, workspaceId) {
  assert.deepEqual(imported.copied, { roles: 1, workflows: 1, knowledgeBundles: 1, toolsets: 1, skills: 1 });
  const copies = {};
  for (const [collection, , key] of collections) {
    assert.equal(imported[collection].length, 1); const copy = imported[collection][0]; copies[key] = copy;
    assert.notEqual(copy.id, originals[key].id); assert.equal(copy.kind, "custom"); assert.equal(copy.workspaceId, workspaceId);
    assert.equal(copy.name, `${originals[key].name}_复制`);
    assert.ok(Number.isSafeInteger(copy.createdAt) && copy.createdAt > 0);
    assert.ok(Number.isSafeInteger(copy.updatedAt) && copy.updatedAt >= copy.createdAt);
  }
  assert.equal(new Set(Object.values(copies).map(copy => copy.id)).size, 5);
  assert.equal(imported.rootAssetId, copies.workflow.id);
  const mapped = (key, id) => {
    assert.equal(id, originals[key].id, `DESKTOP_ASSET_COPY_UNEXPECTED_SOURCE_REFERENCE: ${key}`);
    return copies[key].id;
  };
  for (const [, , key] of collections) {
    const original = originals[key], copy = copies[key];
    const expected = { ...original, id: copy.id, workspaceId, kind: "custom", name: `${original.name}_复制`,
      createdAt: copy.createdAt, updatedAt: copy.updatedAt };
    if (key === "role") {
      expected.builtinGroup = null;
      expected.defaultKnowledgeBundleIds = original.defaultKnowledgeBundleIds.map(id => mapped("knowledge", id));
      expected.defaultSkillIds = original.defaultSkillIds.map(id => mapped("skill", id));
      expected.toolRefs = original.toolRefs.map(ref => ({ ...ref, toolsetId: mapped("toolset", ref.toolsetId) }));
    } else if (key === "workflow") {
      expected.workflowKnowledgeBundleIds = original.workflowKnowledgeBundleIds.map(id => mapped("knowledge", id));
      expected.nodes = original.nodes.map(node => ({ ...node, roleId: node.roleId ? mapped("role", node.roleId) : node.roleId ?? null,
        knowledgeOverrideBundleIds: (node.knowledgeOverrideBundleIds ?? []).map(id => mapped("knowledge", id)) }));
    } else if (key === "skill") expected.packageHash = copy.packageHash;
    assert.deepEqual(copy, expected, `DESKTOP_ASSET_COPY_DEFINITION_CHANGED: ${key}`);
  }
  assertSkill(originals.skill); assertSkill(copies.skill); assert.notEqual(copies.skill.packageHash, originals.skill.packageHash);
  return copies;
}

/** 成功只新增完整图，原件保持；直接核原始定义和文件，禁止读取规范化掩盖坏行。 */
function assertCopyRows(before, after, copies) {
  for (const [index, table] of assetTables.entries()) {
    const oldRows = before[table], newRows = after[table];
    const key = table === "orch_skill_files" ? row => `${row.skill_id}:${row.rel_path}` : row => row.id;
    const oldKeys = new Set(oldRows.map(key));
    assert.deepEqual(newRows.filter(row => oldKeys.has(key(row))), oldRows, `DESKTOP_ASSET_COPY_ORIGINAL_CHANGED: ${table}`);
    const added = newRows.filter(row => !oldKeys.has(key(row)));
    assert.equal(added.length, table === "orch_skill_files" ? copies.skill.files.length : 1);
    if (table === "orch_skill_files") {
      for (const file of copies.skill.files) {
        const row = added.find(item => item.rel_path === file.relPath);
        assert.deepEqual(row, { skill_id: copies.skill.id, rel_path: file.relPath, kind: file.kind,
          content_text: file.contentText ?? null, content_base64: file.contentBase64 ?? null, content_type: file.contentType ?? null,
          size_bytes: file.sizeBytes, sha256: file.sha256, updated_at: copies.skill.updatedAt });
        const bytes = row.content_text != null ? Buffer.from(row.content_text, "utf8") : Buffer.from(row.content_base64, "base64");
        assert.equal(row.size_bytes, bytes.length); assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
      }
      continue;
    }
    const row = added[0], copy = copies[collections[index][2]];
    assert.equal(row.id, copy.id); assert.equal(row.workspace_id, copy.workspaceId); assert.equal(row.name, copy.name);
    assert.equal(row.created_at, copy.createdAt); assert.equal(row.updated_at, copy.updatedAt);
    let expectedDefinition = copy;
    if (table === "orch_roles" || table === "orch_workflows") {
      const { createdAt, updatedAt, ...definition } = copy;
      expectedDefinition = definition;
    } else if (table === "orch_skills") {
      expectedDefinition = { ...copy, files: copy.files.map(file => ({ relPath: file.relPath, kind: file.kind,
        contentType: file.contentType ?? null, sizeBytes: file.sizeBytes, sha256: file.sha256 })) };
    }
    assert.deepEqual(JSON.parse(row.definition_json), expectedDefinition, `DESKTOP_ASSET_COPY_RAW_DEFINITION_MISMATCH: ${table}`);
    if (table === "orch_roles") {
      assert.equal(row.system_prompt, copy.systemPrompt); assert.equal(row.kind, copy.kind);
      assert.deepEqual(JSON.parse(row.execution_config_json), copy.executionConfig);
    } else if (table === "orch_workflows") {
      assert.equal(row.version, copy.version); assert.deepEqual(JSON.parse(row.nodes_json), copy.nodes); assert.deepEqual(JSON.parse(row.edges_json), copy.edges);
    } else if (table === "orch_knowledge_bundles") assert.equal(row.scope, copy.scope);
    if (Object.hasOwn(row, "description")) assert.equal(row.description, copy.description);
  }
}

/** 故障后同一个 Client PID、身份和资产读取必须继续可用。 */
async function assertRecovered(run, workspaceId, originals) {
  assert.equal((await request("runtime.info")).client.clientId, run.clientId);
  const state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_ASSET_COPY_RECOVERY_TIMEOUT");
  assert.equal(state.status, "ready"); assert.equal(state.pid, run.state.pid); assert.equal(state.health.database, "ready");
  assert.equal(processState(state.pid).state, "alive"); assertOnlyOriginals(await assetLists(workspaceId), originals);
  return state;
}

/** 关闭后严格读取日志，唯一故障需携带原请求 UUID、工作区、方法和根因。 */
async function failureLog(workspaceId) {
  const calls = report.requests.filter(item => item.method === "orch.assets.copy" && item.response.status === 500);
  assert.equal(calls.length, 1, "DESKTOP_ASSET_COPY_UNIQUE_FAILURE_CALL_REQUIRED");
  assert.equal(calls[0].body.workspaceId, workspaceId); assert.equal(calls[0].body.assetType, "workflow");
  assert.equal(calls[0].response.body?.ok, false); assert.equal(calls[0].response.body?.message, marker);
  const directory = path.join(root, "runtime/logs");
  const files = (await bounded(fs.readdir(directory), 5_000, "DESKTOP_ASSET_COPY_LOG_LIST_TIMEOUT"))
    .filter(name => /^client(?:[-.][\w.-]+)?\.log(?:\.\d+)?$/iu.test(name));
  assert.ok(files.length > 0, "DESKTOP_ASSET_COPY_CLIENT_LOG_MISSING");
  const rows = [];
  for (const name of files) {
    const text = await bounded(fs.readFile(path.join(directory, name), "utf8"), 5_000, "DESKTOP_ASSET_COPY_LOG_READ_TIMEOUT");
    rows.push(...text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line)));
  }
  const errors = rows.filter(row => row.level === "ERROR");
  const matches = errors.filter(row => row.message === "failed api.req" && row.method === "orch.assets.copy"
    && row.workspaceId === workspaceId && row.rootCause === marker);
  assert.equal(matches.length, 1, "DESKTOP_ASSET_COPY_FAILURE_LOG_REQUIRED");
  const entry = matches[0]; assert.equal(entry.module, "orch-api"); assert.equal(entry.code, "ORCH_API_REQUEST_FAILED");
  assert.match(entry.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(entry.id, entry.requestId); assert.notEqual(entry.requestId, report.requestId);
  assert.ok(report.runs.every(run => run.state.requestId !== entry.requestId), "DESKTOP_ASSET_COPY_PARENT_REQUEST_ID_REUSED");
  assert.deepEqual(errors, matches, "DESKTOP_ASSET_COPY_UNEXPECTED_CLIENT_ERRORS");
  return { files, entry, errorCount: errors.length, requestIdSource: "client_owned_error_boundary_log",
    requestBinding: { method: calls[0].method, workspaceId, assetId: calls[0].body.assetId, reason: marker, failedCallCount: calls.length } };
}

/** 失败仅清理当前直接观测进程，未知状态、清理错和残留均显式失败。 */
async function cleanup() {
  const errors = [];
  for (const pid of observedPids) {
    const state = processState(pid);
    if (state.state === "absent") continue;
    if (state.state === "unknown") { errors.push(new Error(`DESKTOP_ASSET_COPY_PID_UNKNOWN: ${JSON.stringify(state)}`)); continue; }
    const killed = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/taskkill.exe"),
      ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
    if (killed.error || killed.status !== 0) errors.push(killed.error ?? new Error(`DESKTOP_ASSET_COPY_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`));
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_ASSET_COPY_CLOSE_TIMEOUT"); } catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.cleanup = { processes: processFacts() };
  if (report.cleanup.processes.some(item => item.state !== "absent")) errors.push(new Error("DESKTOP_ASSET_COPY_CLEANUP_UNCONFIRMED"));
  report.cleanup.status = errors.length ? "failed" : "stopped";
  if (errors.length) throw new AggregateError(errors, "DESKTOP_ASSET_COPY_CLEANUP_FAILED");
}

/** 错误及聚合 cause 链完整输出，不能把断言或关闭失败伪装为通过。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.code != null ? { code: error.code } : {}),
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

try {
  report.executable = executable;
  ({ _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test"));
  env = await isolatedEnvironment();
  const project = path.join(root, "project");
  await bounded(fs.mkdir(project), 5_000, "DESKTOP_ASSET_COPY_PROJECT_TIMEOUT");
  await bounded(fs.mkdir(path.join(root, "profile")), 5_000, "DESKTOP_ASSET_COPY_PROFILE_TIMEOUT");
  report.phase = "create-originals"; const first = await launch(1);
  assert.deepEqual((await request("workspaces.list")).workspaces, []);
  const workspace = (await request("workspaces.upsert", { workspaceId: "asset-copy", title: "完整依赖复制验收", path: project })).workspace;
  assert.equal(workspace.id, `${first.clientId}:asset-copy`);
  const originals = await createAssets(workspace.id); report.originals = originals; report.workspace = workspace;
  assertOnlyOriginals(await assetLists(workspace.id), originals); assertSkill(originals.skill);
  report.initialIdle = assertIdle(); await exit(first);
  report.phase = "install-fault-offline"; report.triggerInstalled = changeTrigger(true, workspace.id, originals.workflow.name);
  report.phase = "failed-copy"; const second = await launch(2); assert.equal(second.clientId, first.clientId);
  assertOnlyOriginals(await assetLists(workspace.id), originals);
  report.beforeFailure = assetSnapshot(workspace.id);
  const copyRequest = { workspaceId: workspace.id, assetType: "workflow", assetId: originals.workflow.id };
  report.failedCopy = await request("orch.assets.copy", copyRequest, 500); assert.equal(report.failedCopy.message, marker);
  report.afterFailure = assetSnapshot(workspace.id); assert.deepEqual(report.afterFailure, report.beforeFailure);
  report.recovered = await assertRecovered(second, workspace.id, originals); report.failureIdle = assertIdle();
  await exit(second); assert.deepEqual(assetSnapshot(workspace.id), report.afterFailure);
  report.failureLog = await failureLog(workspace.id); report.failureRequestId = report.failureLog.entry.requestId;
  report.phase = "remove-fault-offline"; report.triggerRemoved = changeTrigger(false, workspace.id, originals.workflow.name);
  report.phase = "retry-copy"; const third = await launch(3); assert.equal(third.clientId, first.clientId);
  assertOnlyOriginals(await assetLists(workspace.id), originals); const beforeRetry = assetSnapshot(workspace.id);
  report.imported = (await request("orch.assets.copy", copyRequest)).imported;
  report.copies = assertCopiedGraph(report.imported, originals, workspace.id);
  const lists = await assetLists(workspace.id);
  for (const [, , key] of collections) {
    const personal = lists[key].filter(asset => asset.kind === "custom"); assert.equal(personal.length, 2);
    assert.deepEqual(personal.find(asset => asset.id === originals[key].id), originals[key]);
    assert.deepEqual(personal.find(asset => asset.id === report.copies[key].id), report.copies[key]);
  }
  report.afterRetry = assetSnapshot(workspace.id); assertCopyRows(beforeRetry, report.afterRetry, report.copies);
  report.retryIdle = assertIdle(); await exit(third);
  report.phase = "persisted-verification"; assert.deepEqual(assetSnapshot(workspace.id), report.afterRetry); report.finalIdle = assertIdle();
  assert.deepEqual(await failureLog(workspace.id), report.failureLog);
  report.artifactAfter = await artifactHashes(executable); assert.deepEqual(report.artifactAfter, report.artifactBefore);
  report.cleanup = { status: "stopped", processes: report.runs.flatMap(run => run.processes) }; report.status = "passed";
} catch (error) {
  report.failedPhase = report.phase;
  try { await cleanup(); } catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_ASSET_COPY_VERIFICATION_AND_CLEANUP_FAILED"); }
  report.status = "failed"; report.failure = failure(error); process.exitCode = 1;
}
try { await bounded(fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"), 10_000, "DESKTOP_ASSET_COPY_REPORT_TIMEOUT"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_ASSET_COPY_REPORT_WRITE_FAILED"); }
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_ASSET_COPY_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, ...(report.failure ? { failedPhase: report.failedPhase, failure: report.failure, cleanup: report.cleanup } : {}) }));
