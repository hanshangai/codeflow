import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ControlledExperimentFreezeRpcRequest,
  ControlledExperimentRunRpcResult,
  ControlledExperimentRunStartRpcRequest,
  ConversationEventInput,
  RawEngineEventInput,
  EngineCustomModelEntry,
  WorkspaceId,
} from "@codeflowai/shared";
import { MANUAL_TURN_INTERRUPT_CODE } from "@codeflowai/shared";

import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";
import { ControlledExperimentExecutor } from "../src/experiments/controlledExperimentExecutor.ts";
import { buildPromptDefinitionHash } from "../src/orchestration/promptDefinitionHash.ts";
import { setEngineModelCatalogCustomModels } from "../src/engines/engineModelCatalogRuntime.ts";
import { logger } from "../src/logger.js";

const WORKSPACE_ID = "client-test:controlled-experiment" as WorkspaceId;
const MODEL = "gpt-5.2-codex";

test("受控实验真实Writer覆盖启动事件状态取消和原执行排空", async () => {
  const f = createFixture({ mode: "deferred" });
  const frozen = f.executor.freeze(f.freezeRequest);
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(f.workspacePath, "client.db"), onFatalError(error) { throw error; } });
  try {
    await writer.ready();
    f.executorDeps.withLegacyDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
    f.sessionHooks.afterSend = async () => { assert.throws(() => f.db.controlledExperiments.listRecoverableRuns(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u); };
    const request = createRunRequest(frozen, "writer-run", "writer-token");
    await writer.withLegacyDatabase("dispatch-run", () => f.executor.start(request));
    await f.sendStarted;
    const query = { contractVersion: 1, experimentId: request.experimentId, runId: request.runId, dispatchTokenSha256: sha256Text(request.dispatchToken) };
    const running = await f.executor.status(query);
    assert.equal(running.ok && running.status, "running");
    await f.executor.cancel(query);
    f.releaseSend();
    await f.executor.stopForUpdate({ requestId: "writer-stop" });
    assert.equal(f.executor.hasInFlightWork(), false);
    const terminal = await f.executor.status(query);
    assert.equal(terminal.ok && terminal.status, "cancelled");
  } finally { f.releaseSend(); try { await f.executor.dispose(); } finally { await writer.close(); f.cleanup(); } }
});

test("实验更新准入冻结拒绝派发，冻结前待调用任务可取消且不调用模型", async () => {
  let paused = false;
  const fixture = createFixture({ isTaskAdmissionPaused: () => paused });
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const first = createRunRequest(frozen, "update-admission-first", "update-admission-first");
    paused = true;
    assert.throws(() => fixture.executor.start(first), { code: "DESKTOP_UPDATE_IN_PROGRESS" });
    assert.equal(fixture.db.controlledExperiments.getRun(first.runId), null);
    paused = false;
    fixture.executor.start(first);
    paused = true;
    await fixture.executor.stopForUpdate({ requestId: "stop-before-launch" });
    assert.equal(fixture.sessionCalls(), 0);
    assert.equal(fixture.db.controlledExperiments.getRun(first.runId)?.status, "cancelled");
    assert.equal(fixture.executor.hasInFlightWork(), false);
    paused = false;
    fixture.executor.start(createRunRequest(frozen, "update-admission-resumed", "update-admission-resumed"));
    await waitForTerminal(fixture.executor, createRunRequest(frozen, "update-admission-resumed", "update-admission-resumed"));
    assert.equal(fixture.sessionCalls(), 1);
  } finally { await fixture.executor.dispose(); fixture.cleanup(); }
});

test("实验更新停止等待模型和释放完成，取消不会继续派发待运行实验", async () => {
  const fixture = createFixture({ mode: "deferred" });
  let releaseDispose!: () => void;
  const disposed = new Promise<void>(resolve => { releaseDispose = resolve; });
  fixture.sessionHooks.dispose = () => disposed;
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const first = createRunRequest(frozen, "update-stop-first", "update-stop-first");
    const second = createRunRequest(frozen, "update-stop-second", "update-stop-second");
    fixture.executor.start(first); await fixture.sendStarted; fixture.executor.start(second);
    assert.equal(fixture.executor.hasInFlightWork(), true);
    let finished = false;
    const stopping = fixture.executor.stopForUpdate({ requestId: "stop-live" }).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    fixture.releaseSend();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    releaseDispose(); await stopping;
    assert.equal(fixture.executor.hasInFlightWork(), false);
    assert.equal(fixture.db.controlledExperiments.getRun(first.runId)?.status, "cancelled");
    assert.equal(fixture.db.controlledExperiments.getRun(second.runId)?.status, "cancelled");
    assert.equal(fixture.sessionCalls(), 1);
  } finally { fixture.releaseSend(); releaseDispose(); await fixture.executor.dispose(); fixture.cleanup(); }
});

test("实验更新停止释放失败保留失败原因，重复停止不能假成功", async t => {
  const fixture = createFixture({ mode: "deferred" });
  const cause = new Error("experiment-dispose-root token=synthetic-experiment-secret");
  const logs: unknown[] = [];
  const writeWorkspaceLog = fixture.db.writeWorkspaceLog;
  t.mock.method(fixture.db, "writeWorkspaceLog", (workspaceId, entry) => {
    writeWorkspaceLog(workspaceId, entry);
    logs.push(entry.data);
  });
  fixture.sessionHooks.dispose = async () => { throw cause; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-dispose-failure", "update-dispose-failure");
    fixture.executor.start(request); await fixture.sendStarted;
    const stopping = fixture.executor.stopForUpdate({ requestId: "stop-dispose-failure" });
    const rejected = assert.rejects(stopping, error => error === cause);
    fixture.releaseSend(); await rejected;
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "failed");
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.errorCode, "ENGINE_SESSION_DISPOSE_FAILED");
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-dispose-failure" }), error => error === cause);
    assert.ok(JSON.stringify(logs).includes("experiment-dispose-root"));
    assert.equal(JSON.stringify(logs).includes("synthetic-experiment-secret"), false);
  } finally { fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("实验更新停止超时保留真实活动，晚到完成后仍可重试", async () => {
  const fixture = createFixture({ mode: "deferred" });
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-timeout", "update-timeout");
    fixture.executor.start(request); await fixture.sendStarted;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "stop-timeout", timeoutMs: 10 }), { code: "DESKTOP_UPDATE_EXPERIMENT_STOP_TIMEOUT" });
    assert.equal(fixture.executor.hasInFlightWork(), true);
    fixture.releaseSend();
    await fixture.executor.stopForUpdate({ requestId: "stop-after-timeout" });
    assert.equal(fixture.executor.hasInFlightWork(), false);
  } finally { fixture.releaseSend(); await fixture.executor.dispose(); fixture.cleanup(); }
});

test("实验更新冻结时状态查询不恢复尚未调用的派发", async () => {
  let paused = false;
  const fixture = createFixture({ isTaskAdmissionPaused: () => paused });
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-status", "update-status");
    fixture.executor.start(request); paused = true;
    await new Promise(resolve => setImmediate(resolve));
    const status = await fixture.executor.status({ contractVersion: 1, experimentId: request.experimentId, runId: request.runId, dispatchTokenSha256: sha256Text(request.dispatchToken) });
    assert.equal(status.ok && status.status, "dispatched");
    await fixture.executor.recoverOnStartup();
    assert.equal(fixture.sessionCalls(), 0);
    await fixture.executor.stopForUpdate({ requestId: "stop-status" });
  } finally { await fixture.executor.dispose(); fixture.cleanup(); }
});

for (const mode of ["reject", "false"] as const) test(`实验更新中断${mode}失败不能被迟到完成清除`, async () => {
  const fixture = createFixture({ mode: "deferred" });
  const cause = new Error("experiment-interrupt-root");
  fixture.sessionHooks.interrupt = async () => { if (mode === "reject") throw cause; return false; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), `update-interrupt-${mode}`, `update-interrupt-${mode}`);
    fixture.executor.start(request); await fixture.sendStarted;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "stop-interrupt" }));
    fixture.releaseSend(); await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-interrupt" }));
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "failed");
  } finally { fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

for (const acknowledged of [false, true]) test(`实验更新对账 detached 必须获取精确 provider 确认：${acknowledged}`, async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, `update-detached-${acknowledged}`);
  let providerInput: any;
  const executor = new ControlledExperimentExecutor({
    db: fixture.db, workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() { throw new Error("更新取消不得重新派发模型"); },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds(input: any) {
        providerInput = input;
        return acknowledged ? { kind: "ready", actualEngineTurnId: `provider-turn-${request.runId}`, allowSiblingRunning: true } as const
          : { kind: "error", code: "codex_thread_resume_unrecoverable", message: "provider unavailable", dropSessionBinding: false } as const;
      },
      async reconcileCodexDanglingTurn() { throw new Error("明确中断结果后不另做对账"); },
    },
  });
  try {
    if (acknowledged) {
      await executor.stopForUpdate({ requestId: "stop-detached" });
      assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancelled");
    } else {
      await assert.rejects(executor.stopForUpdate({ requestId: "stop-detached" }));
      assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancel_requested");
    }
    assert.equal(providerInput.exactProviderTurn, true);
    assert.equal(providerInput.engineSessionId, `provider-session-${request.runId}`);
    assert.equal(providerInput.engineTurnId, `provider-turn-${request.runId}`);
  } finally { await executor.dispose(); fixture.cleanup(); }
});

test("实验更新无法证明持久调用已停止时保留非终态", async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, "update-missing-provider");
  fixture.db.db.prepare("UPDATE controlled_experiment_runs SET engine_turn_id = NULL WHERE id = ?").run(request.runId);
  try {
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "stop-missing-provider" }));
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancel_requested");
    assert.equal(fixture.sessionCalls(), 0);
  } finally { await fixture.executor.dispose(); fixture.cleanup(); }
});

test("实验更新并发停止只派发一次中断且等待同一清理", async () => {
  const fixture = createFixture({ mode: "deferred" });
  let interrupts = 0;
  fixture.sessionHooks.interrupt = async () => { interrupts++; return true; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-concurrent", "update-concurrent");
    fixture.executor.start(request); await fixture.sendStarted;
    const first = fixture.executor.stopForUpdate({ requestId: "stop-concurrent-first" });
    const second = fixture.executor.stopForUpdate({ requestId: "stop-concurrent-second" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(interrupts, 1);
    fixture.releaseSend(); await Promise.all([first, second]);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancelled");
  } finally { fixture.releaseSend(); await fixture.executor.dispose(); fixture.cleanup(); }
});

test("实验更新在释放期间到达的中断失败也必须失败", async () => {
  const fixture = createFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cause = new Error("late-interruption-root");
  fixture.sessionHooks.dispose = async () => { entered(); await gate; };
  fixture.sessionHooks.interrupt = async () => { throw cause; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-during-dispose", "update-during-dispose");
    fixture.executor.start(request); await started;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "stop-during-dispose" }), error => error === cause);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-during-dispose" }), error => error === cause);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "failed");
  } finally { release(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("实验更新对账超时后保留在途 owner，重试等待原 provider 请求", async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, "update-detached-timeout");
  let release!: () => void, interrupts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executor = new ControlledExperimentExecutor({
    db: fixture.db, workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() { throw new Error("对账不得派发"); },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds() { interrupts++; await gate; return { kind: "ready", actualEngineTurnId: `provider-turn-${request.runId}`, allowSiblingRunning: true } as const; },
      async reconcileCodexDanglingTurn() { throw new Error("ACK 后不得另对账"); },
    },
  });
  try {
    await assert.rejects(executor.stopForUpdate({ requestId: "detached-timeout", timeoutMs: 10 }), { code: "DESKTOP_UPDATE_EXPERIMENT_STOP_TIMEOUT" });
    assert.equal(executor.hasInFlightWork(), true);
    const retry = executor.stopForUpdate({ requestId: "detached-retry" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(interrupts, 1);
    release(); await retry;
    assert.equal(executor.hasInFlightWork(), false);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancelled");
  } finally { release(); await executor.dispose(); fixture.cleanup(); }
});

test("实验更新保留已收口失败证据时不阻止其他新实验", async () => {
  const fixture = createFixture({ mode: "deferred" });
  fixture.sessionHooks.interrupt = async () => { throw new Error("settled-interrupt-failure"); };
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const first = createRunRequest(frozen, "update-failed-owner", "update-failed-owner");
    fixture.executor.start(first); await fixture.sendStarted;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "stop-failed-owner" }));
    fixture.releaseSend(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.executor.hasInFlightWork(), false);
    const second = createRunRequest(frozen, "update-next-owner", "update-next-owner");
    fixture.executor.start(second);
    await waitForTerminal(fixture.executor, second);
    assert.equal(fixture.sessionCalls(), 2);
  } finally { fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("实验更新超时对账迟到失败可显式重试且不伪成功", async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, "update-detached-late-failure");
  let rejectFirst!: (error: Error) => void, interrupts = 0;
  const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
  const cause = new Error("detached-late-failure");
  const executor = new ControlledExperimentExecutor({
    db: fixture.db, workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() { throw new Error("对账不得派发"); },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds() {
        interrupts++; if (interrupts === 1) await first;
        return { kind: "ready", actualEngineTurnId: `provider-turn-${request.runId}`, allowSiblingRunning: true } as const;
      },
      async reconcileCodexDanglingTurn() { throw new Error("ACK 后不得另对账"); },
    },
  });
  try {
    await assert.rejects(executor.stopForUpdate({ requestId: "late-failure-timeout", timeoutMs: 10 }), { code: "DESKTOP_UPDATE_EXPERIMENT_STOP_TIMEOUT" });
    rejectFirst(cause); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(executor.stopForUpdate({ requestId: "observe-late-failure" }), error => error === cause);
    await executor.stopForUpdate({ requestId: "retry-late-failure" });
    assert.equal(interrupts, 2);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancelled");
  } finally { await executor.dispose(); fixture.cleanup(); }
});

for (const stage of ["execution", "cleanup"] as const) for (const rejection of [undefined, null, NaN]) test(`实验更新${stage}拒绝${String(rejection)}仍失败且保留原原因`, async () => {
  const fixture = createFixture({ mode: "deferred" });
  if (stage === "execution") fixture.sessionHooks.afterSend = async () => { throw rejection; };
  else fixture.sessionHooks.dispose = async () => { throw rejection; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), `unknown-${stage}-${String(rejection)}`, `unknown-${stage}-${String(rejection)}`);
    fixture.executor.start(request); await fixture.sendStarted;
    const stopping = fixture.executor.stopForUpdate({ requestId: "stop-unknown-rejection" });
    const rejected = assert.rejects(stopping, error => Object.is(error, rejection));
    fixture.releaseSend(); await rejected;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-unknown-rejection" }), error => Object.is(error, rejection));
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "failed");
    assert.equal(fixture.executor.hasInFlightWork(), stage === "cleanup");
  } finally { fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("实验中断方法拒绝即失败，手动取消标记不能冒充中断确认", async () => {
  const fixture = createFixture({ mode: "deferred" });
  const cause = Object.assign(new Error("manual-marked-interrupt-rejection"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
  fixture.sessionHooks.interrupt = async () => { throw cause; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-marked-interrupt", "update-marked-interrupt");
    fixture.executor.start(request); await fixture.sendStarted;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "stop-marked-interrupt" }), error => error === cause);
    fixture.releaseSend(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-marked-interrupt" }), error => error === cause);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "failed");
  } finally { fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("实验执行中断清理同时拒绝时保留各来源且去重 NaN", async () => {
  const fixture = createFixture({ mode: "deferred" });
  fixture.sessionHooks.afterSend = async () => { throw NaN; };
  fixture.sessionHooks.interrupt = async () => { throw NaN; };
  fixture.sessionHooks.dispose = async () => { throw undefined; };
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-combined-unknown", "update-combined-unknown");
    fixture.executor.start(request); await fixture.sendStarted;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "first-combined-unknown" }), error => Number.isNaN(error));
    fixture.releaseSend(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-combined-unknown" }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.ok(error.errors.some(value => Number.isNaN(value)));
      assert.ok(error.errors.includes(undefined));
      return true;
    });
    assert.equal(fixture.executor.hasInFlightWork(), true);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.errorCode, "ENGINE_SESSION_DISPOSE_FAILED");
  } finally { fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("实验清理与终态写入双故障同时保留，失败引用不能丢失", async () => {
  const fixture = createFixture({ mode: "deferred" });
  const cleanup = new Error("experiment-cleanup-before-persistence");
  fixture.sessionHooks.dispose = async () => { throw cleanup; };
  /** 展开标准错误树核对原对象，不依赖聚合文案或嵌套顺序。 */
  const containsCause = (error: unknown): boolean => error === cleanup || error instanceof AggregateError && error.errors.some(containsCause)
    || error instanceof Error && error.cause !== undefined && containsCause(error.cause);
  try {
    const request = createRunRequest(fixture.executor.freeze(fixture.freezeRequest), "update-cleanup-persistence", "update-cleanup-persistence");
    fixture.executor.start(request); await fixture.sendStarted;
    fixture.db.db.exec("CREATE TRIGGER refuse_experiment_terminal BEFORE UPDATE OF status ON controlled_experiment_runs WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'experiment-terminal-persistence-root'); END");
    const stopping = fixture.executor.stopForUpdate({ requestId: "stop-cleanup-persistence" });
    const rejected = assert.rejects(stopping, error => {
      assert.equal(containsCause(error), true);
      assert.match(JSON.stringify(error, Object.getOwnPropertyNames(error as object)), /experiment-terminal-persistence-root/);
      return true;
    });
    fixture.releaseSend(); await rejected;
    await assert.rejects(fixture.executor.stopForUpdate({ requestId: "repeat-cleanup-persistence" }), containsCause);
    assert.equal(fixture.executor.hasInFlightWork(), true);
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.status, "cancel_requested");
  } finally { fixture.db.db.exec("DROP TRIGGER IF EXISTS refuse_experiment_terminal"); fixture.releaseSend(); await assert.rejects(fixture.executor.dispose()); fixture.cleanup(); }
});

test("受控实验冻结拒绝运行时文件依赖且失败批次不落库", () => {
  const fixture = createFixture();
  try {
    const valid = fixture.executor.freeze(fixture.freezeRequest);
    assert.equal(valid.samples.length, 1);
    assert.equal(valid.variants.length, 2);
    assert.equal(fixture.db.controlledExperiments.listSnapshotsByFreeze("experiment-valid", 1).length, 2);

    const source = fixture.db.orchPromptSnapshots.get("prompt-snapshot-1");
    assert.ok(source);
    const withRuntimePath = {
      ...source.promptEnvelope,
      knowledge: {
        ...source.promptEnvelope.knowledge,
        catalogs: [{
          bundleId: "bundle-runtime",
          scope: "shared",
          createdAt: 1,
          inlineItems: [],
          runtimeSources: [{
            bundleId: "bundle-runtime",
            sourceId: "source-runtime",
            sourceKey: "source-runtime",
            sourceKind: "file",
            title: "runtime source",
            originRef: "docs/runtime.md",
            workspaceRelPath: "docs/runtime.md",
            targetType: "file",
          }],
        }],
      },
    };
    fixture.db.db.prepare("UPDATE orch_prompt_snapshots SET prompt_envelope_json = ? WHERE id = ?")
      .run(JSON.stringify(withRuntimePath), "prompt-snapshot-1");
    const invalidRequest = {
      ...fixture.freezeRequest,
      experimentId: "experiment-invalid",
      baselineCohort: {
        ...fixture.freezeRequest.baselineCohort,
        promptDefinitionHash: buildPromptDefinitionHash(
          withRuntimePath as any,
          fixture.freezeRequest.baselineCohort.workflowSnapshotHash,
          fixture.freezeRequest.baselineCohort.nodeId,
          fixture.freezeRequest.baselineCohort.roleSnapshotHash,
        ),
      },
      items: fixture.freezeRequest.items.map((item) => ({
        ...item,
        expectedPromptSha256: sha256Json({
          promptEnvelope: withRuntimePath,
          systemMessage: source.systemMessage,
          developerMessage: source.developerMessage ?? null,
          userMessage: source.userMessage,
        }),
      })),
    };
    assert.throws(() => fixture.executor.freeze(invalidRequest), /运行时知识路径/);
    assert.equal(fixture.db.controlledExperiments.listSnapshotsByFreeze("experiment-invalid", 1).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("受控实验冻结拒绝目录未声明的 effort", () => {
  const fixture = createFixture();
  try {
    const request = {
      ...fixture.freezeRequest,
      experimentId: "experiment-invalid-effort",
      candidate: { ...fixture.freezeRequest.candidate, effort: "ultra" as const },
    };
    assert.throws(() => fixture.executor.freeze(request), /不支持思考强度/);
    assert.equal(fixture.db.controlledExperiments.listSnapshotsByFreeze(request.experimentId, 1).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("受控实验候选模型沿用代码级历史 alias 的动态 Provider", () => {
  const fixture = createFixture();
  try {
    const request = {
      ...fixture.freezeRequest,
      experimentId: "experiment-legacy-alias-provider",
      candidate: { engine: "claude" as const, model: "deepseek-v4-flash", effort: null },
    };
    const frozen = fixture.executor.freeze(request);
    assert.equal(frozen.variants.find((variant) => variant.variantKey === "candidate")?.model, "deepseek-v4-flash");
  } finally {
    fixture.cleanup();
  }
});

test("受控实验重复冻结重放首次提交证据", () => {
  const fixture = createFixture();
  try {
    const first = fixture.executor.freeze(fixture.freezeRequest);
    fixture.clock.now += 10_000;

    const repeated = fixture.executor.freeze(fixture.freezeRequest);

    assert.deepEqual(repeated, first);
    assert.equal(fixture.db.controlledExperiments.listSnapshotsByFreeze("experiment-valid", 1).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("受控实验取消后迟到模型成功不能覆盖 cancelled 终态", async () => {
  const fixture = createFixture({ mode: "deferred" });
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const request = createRunRequest(frozen, "run-cancelled", "dispatch-cancelled");
    fixture.executor.start(request);
    await fixture.sendStarted;

    const cancelling = await fixture.executor.cancel({
      contractVersion: 1,
      experimentId: request.experimentId,
      runId: request.runId,
      dispatchTokenSha256: sha256Text(request.dispatchToken),
    });
    assert.equal(cancelling.ok, true);
    if (cancelling.ok) assert.equal(cancelling.status, "cancel_requested");

    fixture.releaseSend();
    const terminal = await waitForTerminal(fixture.executor, request);
    assert.equal(terminal.ok, true);
    if (terminal.ok) assert.equal(terminal.status, "cancelled");
  } finally {
    fixture.releaseSend();
    await fixture.executor.dispose();
    fixture.cleanup();
  }
});

test("受控实验重启对账不发起第二次模型调用且保留工具阻断", async () => {
  const fixture = createFixture();
  const frozen = fixture.executor.freeze(fixture.freezeRequest);
  const request = createRunRequest(frozen, "run-recovery", "dispatch-recovery");
  const snapshot = fixture.db.controlledExperiments.getLatestSnapshot(request.experimentId, request.sampleId, request.variantKey);
  assert.ok(snapshot);
  fixture.db.controlledExperiments.createDispatchedRun({
    id: request.runId,
    experimentId: request.experimentId,
    assignmentId: request.assignmentId,
    sampleId: request.sampleId,
    variantKey: request.variantKey,
    attemptNo: request.attemptNo,
    snapshotId: snapshot.id,
    dispatchTokenSha256: sha256Text(request.dispatchToken),
    clientTurnId: "turn-recovery" as any,
    engine: snapshot.engine,
    deadlineAt: request.deadlineAt,
    now: fixture.clock.now,
  });
  fixture.db.controlledExperiments.markRunning(request.runId, fixture.clock.now);
  fixture.db.controlledExperiments.bindProviderIds(request.runId, {
    engineSessionId: "provider-session-recovery",
    engineTurnId: "provider-turn-recovery",
  });
  fixture.db.controlledExperiments.appendEvent(request.runId, {
    kind: "conversation",
    event: { type: "item.tool.started", payload: { toolName: "commandExecution" } },
  });
  let sessionCalls = 0;
  let interruptCalls = 0;
  let interruptInput: any = null;
  let reconcileCalls = 0;
  const recovered = new ControlledExperimentExecutor({
    db: fixture.db,
    workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() {
        sessionCalls += 1;
        throw new Error("重启对账不得创建隔离会话");
      },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds(input: any) {
        interruptCalls += 1;
        interruptInput = input;
        return {
          kind: "ready",
          actualEngineTurnId: "provider-turn-recovery",
          allowSiblingRunning: true,
        } as const;
      },
      async reconcileCodexDanglingTurn() {
        reconcileCalls += 1;
        throw new Error("provider interrupt ACK 后不得继续读取终态");
      },
    },
    now: () => fixture.clock.now,
  });
  try {
    await recovered.recoverOnStartup();
    assert.equal(sessionCalls, 0);
    assert.equal(interruptCalls, 1);
    assert.equal(interruptInput?.turnId, "turn-recovery");
    assert.equal(interruptInput?.exactProviderTurn, true);
    assert.equal(interruptInput?.clientUserMessageId, undefined);
    assert.equal(reconcileCalls, 0);
    assert.equal(
      fixture.db.controlledExperiments.getRun(request.runId)?.engineTurnId,
      "provider-turn-recovery",
    );
    assert.equal(fixture.db.controlledExperiments.getRun(request.runId)?.errorCode, "SIDE_EFFECT_BLOCKED");
  } finally {
    await recovered.dispose();
    fixture.cleanup();
  }
});

test("受控实验恢复中断未获 ACK 时保留原 Run", async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, "run-interrupt-unconfirmed");
  fixture.db.controlledExperiments.requestCancel(request.runId);
  let reconcileCalls = 0;
  const recovered = new ControlledExperimentExecutor({
    db: fixture.db,
    workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() { throw new Error("恢复对账不得创建隔离会话"); },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds() {
        return {
          kind: "error",
          message: "provider session 尚未恢复",
          code: "codex_thread_resume_unrecoverable",
          dropSessionBinding: false,
        } as const;
      },
      async reconcileCodexDanglingTurn() {
        reconcileCalls += 1;
        throw new Error("中断未获 ACK 时不得继续对账");
      },
    },
    now: () => fixture.clock.now,
  });
  try {
    await recovered.recoverOnStartup();
    const run = fixture.db.controlledExperiments.getRun(request.runId);
    assert.equal(reconcileCalls, 0);
    assert.equal(run?.status, "cancel_requested");
    assert.equal(run?.errorCode, null);
  } finally {
    await recovered.dispose();
    fixture.cleanup();
  }
});

test("受控实验恢复错误不是 provider 终态时保留原 Run", async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, "run-reconcile-unconfirmed");
  const recovered = new ControlledExperimentExecutor({
    db: fixture.db,
    workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() { throw new Error("恢复对账不得创建隔离会话"); },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds() { throw new Error("普通恢复不得中断 provider turn"); },
      async reconcileCodexDanglingTurn() {
        return {
          kind: "error",
          message: "恢复入口暂时不可用",
          code: "codex_thread_resume_unrecoverable",
          dropSessionBinding: false,
        } as const;
      },
    },
    now: () => fixture.clock.now,
  });
  try {
    await recovered.recoverOnStartup();
    const run = fixture.db.controlledExperiments.getRun(request.runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.errorCode, null);
  } finally {
    await recovered.dispose();
    fixture.cleanup();
  }
});

test("受控实验仅用 provider 明确错误终态收口 failed", async () => {
  const fixture = createFixture();
  const request = seedPersistedCodexRun(fixture, "run-provider-terminal");
  fixture.db.controlledExperiments.appendEvent(request.runId, {
    kind: "conversation",
    event: {
      type: "tokenUsage.updated",
      payload: {
        source: "cumulative",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 1,
          cacheCreationInputTokens: 0,
          totalTokens: 15,
        },
      },
    },
  });
  const recovered = new ControlledExperimentExecutor({
    db: fixture.db,
    workspaces: new Map([[WORKSPACE_ID, fixture.workspacePath]]),
    sessions: {
      createIsolatedSession() { throw new Error("恢复对账不得创建隔离会话"); },
      getWorkspacePath: () => fixture.workspacePath,
      async interruptCodexTurnByEngineIds() { throw new Error("普通恢复不得中断 provider turn"); },
      async reconcileCodexDanglingTurn() {
        return {
          kind: "error",
          message: "provider turn failed",
          code: "provider_turn_failed",
          dropSessionBinding: false,
          providerTerminal: true,
        } as const;
      },
    },
    now: () => fixture.clock.now,
  });
  try {
    await recovered.recoverOnStartup();
    const run = fixture.db.controlledExperiments.getRun(request.runId);
    assert.equal(run?.status, "failed");
    assert.equal(run?.errorCode, "provider_turn_failed");
  } finally {
    await recovered.dispose();
    fixture.cleanup();
  }
});

test("受控实验重复 dispatch 只执行一次并持久化完整成功用量", async () => {
  const fixture = createFixture({ mode: "success" });
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const request = createRunRequest(frozen, "run-success", "dispatch-success");
    const first = fixture.executor.start(request);
    const second = fixture.executor.start(request);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    const terminal = await waitForTerminal(fixture.executor, request);
    assert.equal(terminal.ok, true);
    if (!terminal.ok) return;
    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.inputTokens, 10);
    assert.equal(terminal.outputTokens, 5);
    assert.equal(terminal.totalTokens, 15);
    assert.equal(terminal.usageAccountingStatus, "complete");
    assert.equal(fixture.sessionCalls(), 1);
    assert.equal(fixture.db.threads.listByWorkspace(WORKSPACE_ID).threads.length, 0);
    assert.ok(fixture.db.controlledExperiments.getRun("run-success")?.engineTurnId);
  } finally {
    await fixture.executor.dispose();
    fixture.cleanup();
  }
});

test("受控实验按 delta 聚合 GLM 多次 provider 用量并补齐缺失缓存字段", () => {
  const fixture = createFixture();
  try {
    const usage = (fixture.executor as any).resolveCompleteUsage({
      eventLog: [
        {
          kind: "conversation",
          event: {
            type: "tokenUsage.updated",
            payload: {
              source: "cumulative",
              cumulativeMode: "delta",
              tokenUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
            },
          },
        },
        {
          kind: "conversation",
          event: {
            type: "tokenUsage.updated",
            payload: {
              source: "cumulative",
              cumulativeMode: "delta",
              tokenUsage: { inputTokens: 200, outputTokens: 20 },
            },
          },
        },
      ],
    }, { engine: "claude" });

    assert.deepEqual(usage, {
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 330,
    });
  } finally {
    fixture.cleanup();
  }
});

test("受控实验 delta total 缺失后不接受后续 partial total，改按字段推导", () => {
  const fixture = createFixture();
  try {
    const usage = (fixture.executor as any).resolveCompleteUsage({
      eventLog: [
        {
          kind: "conversation",
          event: {
            type: "tokenUsage.updated",
            payload: {
              source: "cumulative",
              cumulativeMode: "delta",
              tokenUsage: { inputTokens: 100, outputTokens: 10 },
            },
          },
        },
        {
          kind: "conversation",
          event: {
            type: "tokenUsage.updated",
            payload: {
              source: "cumulative",
              cumulativeMode: "delta",
              tokenUsage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
            },
          },
        },
      ],
    }, { engine: "claude" });

    assert.deepEqual(usage, {
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 330,
    });
  } finally {
    fixture.cleanup();
  }
});

test("受控实验仅把确定身份冲突映射为 409", async () => {
  const fixture = createFixture({ mode: "deferred" });
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const request = createRunRequest(frozen, "run-conflict", "dispatch-conflict");
    fixture.executor.start(request);
    await fixture.sendStarted;

    assert.throws(
      () => fixture.executor.start({ ...request, dispatchToken: "dispatch-conflict-other" }),
      (error: unknown) => error instanceof Error
        && (error as { status?: unknown }).status === 409
        && (error as { code?: unknown }).code === "CONTROLLED_EXPERIMENT_CONFLICT",
    );
  } finally {
    fixture.releaseSend();
    await fixture.executor.dispose();
    fixture.cleanup();
  }
});

test("受控实验检测到任意 provider 工具尝试后返回 SIDE_EFFECT_BLOCKED", async () => {
  const fixture = createFixture({ mode: "tool" });
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const request = createRunRequest(frozen, "run-side-effect", "dispatch-side-effect");
    fixture.executor.start(request);

    const terminal = await waitForTerminal(fixture.executor, request);
    assert.deepEqual(terminal, {
      ok: false,
      experimentId: "experiment-valid",
      runId: "run-side-effect",
      code: "SIDE_EFFECT_BLOCKED",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      usageAccountingStatus: "complete",
    });
    assert.equal(fixture.sessionCalls(), 1);
  } finally {
    await fixture.executor.dispose();
    fixture.cleanup();
  }
});

test("受控实验即使收到两个误派发 Run 也保持 Client 单调用串行", async () => {
  const fixture = createFixture({ mode: "deferred" });
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const first = createRunRequest(frozen, "run-serial-first", "dispatch-serial-first");
    const second = createRunRequest(frozen, "run-serial-second", "dispatch-serial-second");
    fixture.executor.start(first);
    await fixture.sendStarted;
    const acceptedSecond = fixture.executor.start(second);
    assert.equal(acceptedSecond.ok, true);
    assert.equal(acceptedSecond.ok && acceptedSecond.status, "dispatched");
    assert.equal(fixture.sessionCalls(), 1);

    fixture.releaseSend();
    await waitForTerminal(fixture.executor, first);
    await waitForTerminal(fixture.executor, second);
    assert.equal(fixture.sessionCalls(), 2);
  } finally {
    fixture.releaseSend();
    await fixture.executor.dispose();
    fixture.cleanup();
  }
});

test("受控实验运行前拒绝已失效的活动凭据且不调用模型", async () => {
  const fixture = createFixture();
  try {
    const frozen = fixture.executor.freeze(fixture.freezeRequest);
    const activeKey = fixture.db.engineKeys.getActive("codex", "openai");
    assert.ok(activeKey);
    fixture.db.engineKeys.deactivate(activeKey.id);
    const request = createRunRequest(frozen, "run-credential-invalid", "dispatch-credential-invalid");
    assert.throws(
      () => fixture.executor.start(request),
      /冻结 Provider 或 CodeFlow Key 已失效/,
    );
    assert.equal(fixture.sessionCalls(), 0);
  } finally {
    await fixture.executor.dispose();
    fixture.cleanup();
  }
});

/** 创建已发出且持久化精确 provider pair 的 Codex Run，供重启恢复测试复用。 */
function seedPersistedCodexRun(
  fixture: ReturnType<typeof createFixture>,
  runId: string,
): ControlledExperimentRunStartRpcRequest {
  const frozen = fixture.executor.freeze(fixture.freezeRequest);
  const request = createRunRequest(frozen, runId, `dispatch-${runId}`);
  const snapshot = fixture.db.controlledExperiments.getLatestSnapshot(
    request.experimentId,
    request.sampleId,
    request.variantKey,
  );
  assert.ok(snapshot);
  fixture.db.controlledExperiments.createDispatchedRun({
    id: request.runId,
    experimentId: request.experimentId,
    assignmentId: request.assignmentId,
    sampleId: request.sampleId,
    variantKey: request.variantKey,
    attemptNo: request.attemptNo,
    snapshotId: snapshot.id,
    dispatchTokenSha256: sha256Text(request.dispatchToken),
    clientTurnId: `turn-${runId}` as any,
    engine: snapshot.engine,
    deadlineAt: request.deadlineAt,
    now: fixture.clock.now,
  });
  fixture.db.controlledExperiments.markRunning(request.runId, fixture.clock.now);
  fixture.db.controlledExperiments.bindProviderIds(request.runId, {
    engineSessionId: `provider-session-${runId}`,
    engineTurnId: `provider-turn-${runId}`,
  });
  return request;
}

/** 构造真实 ClientDb、Prompt Snapshot 和可替换隔离 session。 */
function createFixture(options: { mode?: "success" | "tool" | "deferred"; isTaskAdmissionPaused?: () => boolean } = {}) {
  setEngineModelCatalogCustomModels(testEngineModelCustomModels());
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-controlled-experiment-"));
  const rootDb = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  rootDb.workspaces.upsert({ id: WORKSPACE_ID, title: "controlled experiment", path: tempDir });
  const db = rootDb.forWorkspace(WORKSPACE_ID);
  db.engineKeys.insert({ label: "relay", engine: "codex", providerId: "openai", apiKey: "test-key" });
  db.engineKeys.insert({ label: "relay-deepseek", engine: "claude", providerId: "deepseek", apiKey: "test-deepseek-key" });
  insertSourceInstance(db);
  const promptEnvelope = createPromptEnvelope();
  db.orchPromptSnapshots.create({
    instanceId: "source-instance-1" as any,
    nodeId: "node-1",
    attemptNo: 1,
    threadId: null,
    turnId: null,
    engine: "codex",
    model: MODEL,
    effort: "high",
    promptEnvelope: promptEnvelope as any,
    roleExecutionRevision: null,
    systemMessage: "system frozen",
    developerMessage: "developer frozen",
    userMessage: "user frozen",
    renderedInputPreview: "user frozen",
    runtimePolicy: promptEnvelope.runtime.runtimePolicy as any,
    toolRegistry: null,
    knowledgeCatalogs: [],
    artifactInput: { artifacts: [], fieldBindings: {} },
    createdAt: 1_000,
  });
  db.db.prepare("UPDATE orch_prompt_snapshots SET id = ? WHERE instance_id = ?")
    .run("prompt-snapshot-1", "source-instance-1");
  const storedPrompt = db.orchPromptSnapshots.get("prompt-snapshot-1");
  assert.ok(storedPrompt);
  const promptDefinitionHash = buildPromptDefinitionHash(storedPrompt.promptEnvelope as any, "workflow-hash", "node-1", "role-hash");
  const freezeRequest: ControlledExperimentFreezeRpcRequest = {
    contractVersion: 1,
    experimentId: "experiment-valid",
    freezeRevision: 1,
    workspaceId: WORKSPACE_ID,
    baselineCohort: {
      workflowSnapshotHash: "workflow-hash",
      nodeId: "node-1",
      roleSnapshotHash: "role-hash",
      promptDefinitionHash,
      engine: "codex",
      model: MODEL,
      effort: "high",
    },
    candidate: { engine: "codex", model: MODEL, effort: "high" },
    budget: {
      perRunTimeoutMs: 60_000,
      experimentDeadlineMs: 120_000,
      maxTotalTokens: 10_000,
    },
    items: [{
      evaluationItemId: "evaluation-item-1",
      sourceInstanceId: "source-instance-1",
      nodeId: "node-1",
      promptSnapshotId: "prompt-snapshot-1",
      expectedPromptSha256: sha256Json({
        promptEnvelope: storedPrompt.promptEnvelope,
        systemMessage: storedPrompt.systemMessage,
        developerMessage: storedPrompt.developerMessage ?? null,
        userMessage: storedPrompt.userMessage,
      }),
      ordinal: 0,
    }],
  };
  let calls = 0;
  const clock = { now: 1_000 };
  let sendStartedResolve: (() => void) | null = null;
  let releaseSendResolve: (() => void) | null = null;
  const sendStarted = new Promise<void>((resolve) => { sendStartedResolve = resolve; });
  const sendReleased = new Promise<void>((resolve) => { releaseSendResolve = resolve; });
  /** 释放 deferred 模式中的模型响应，重复调用保持幂等。 */
  const releaseSend = (): void => { releaseSendResolve?.(); };
  const sessionHooks = { interrupt: async (): Promise<boolean> => true, dispose: async (): Promise<void> => {}, afterSend: async (): Promise<void> => {} };
  const sessions = {
    createIsolatedSession(input: { onSessionId: (value: string) => void }) {
      calls += 1;
      input.onSessionId("provider-session-1");
      return {
        session: {
          async sendMessage(input: any, emitters: { conversation: (event: ConversationEventInput) => void; raw: (event: RawEngineEventInput) => void }) {
            emitters.raw({
              ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: "run" as any, engine: "codex",
              source: "codex.app-server.msg", data: { method: "turn/started", params: { turn: { id: "provider-turn-1" } } },
              handled: true, action: "ignored", emittedTypes: [],
            });
            emitters.raw({
              ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: "run" as any, engine: "codex",
              clientTurnId: input.turnId,
              source: "codex.app-server.msg",
              data: {
                method: "item/started",
                params: {
                  turnId: "provider-turn-1",
                  item: { type: "userMessage", id: "provider-user-1", clientId: input.userItemId },
                },
              },
              handled: true, action: "mapped", emittedTypes: [],
            });
            if (options.mode === "tool") {
              emitters.conversation({
                ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: "run" as any, engine: "codex",
                type: "item.tool.started", payload: { itemId: "tool-1", toolName: "commandExecution", input: {} },
              } as any);
            }
            emitters.conversation({
              ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: "run" as any, engine: "codex",
              type: "tokenUsage.updated",
              payload: { source: "cumulative", tokenUsage: {
                inputTokens: 10, outputTokens: 5, cachedInputTokens: 1,
                cacheCreationInputTokens: 0, totalTokens: 15, modelContextWindow: 100_000,
              } },
            } as any);
            if (options.mode === "deferred") {
              sendStartedResolve?.();
              await sendReleased;
            }
            await sessionHooks.afterSend();
            return { responseText: "controlled output" };
          },
          async interrupt() { return sessionHooks.interrupt(); },
          async dispose() {},
        },
        async dispose() { await sessionHooks.dispose(); },
      };
    },
    getWorkspacePath() { return tempDir; },
    async interruptCodexTurnByEngineIds() {},
    async reconcileCodexDanglingTurn() { throw new Error("unexpected reconcile"); },
  };
  const executorDeps: ConstructorParameters<typeof ControlledExperimentExecutor>[0] = {
    db,
    workspaces: new Map([[WORKSPACE_ID, tempDir]]),
    sessions: sessions as any,
    now: () => clock.now,
    isTaskAdmissionPaused: options.isTaskAdmissionPaused,
  };
  const executor = new ControlledExperimentExecutor(executorDeps);
  return {
    db,
    executor,
    executorDeps,
    freezeRequest,
    clock,
    workspacePath: tempDir,
    sendStarted,
    releaseSend,
    sessionHooks,
    sessionCalls: () => calls,
    cleanup() {
      rootDb.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function testEngineModelCustomModels(): EngineCustomModelEntry[] {
  return [
    {
      id: "test-claude-model",
      engine: "claude",
      providerId: "anthropic",
      modelId: "claude-test",
      displayName: "Claude Test",
      inputModalities: ["text"],
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      contextWindow: 200_000,
      maxContextWindow: null,
      supportsFastMode: false,
      supports1MContext: false,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "test-codex-model",
      engine: "codex",
      providerId: "openai",
      modelId: MODEL,
      displayName: "GPT Test",
      inputModalities: ["text"],
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "高" }],
      defaultReasoningEffort: "high",
      contextWindow: 200_000,
      maxContextWindow: null,
      supportsFastMode: false,
      supports1MContext: false,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
}

/** 插入 Prompt Snapshot 外键依赖的最小来源实例。 */
function insertSourceInstance(db: ClientDb): void {
  db.db.prepare(`
    INSERT INTO orch_instances (
      id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id, intake_snapshot_json,
      role_snapshots_json, toolset_snapshots_json, runtime_config_json, artifact_index_json,
      master_thread_id, status, node_states_json, created_at, updated_at
    ) VALUES (?, ?, ?, '{}', NULL, '{}', NULL, NULL, NULL, NULL, NULL, 'completed', '{}', ?, ?)
  `).run("source-instance-1", WORKSPACE_ID, "workflow-1", 1_000, 1_000);
}

/** 构造包含中转身份且无运行时文件依赖的最小 Prompt Envelope。 */
function createPromptEnvelope(): Record<string, any> {
  return {
    schemaVersion: "node-prompt-envelope/v1",
    meta: {
      scene: "orchestration-node",
      instanceId: "source-instance-1",
      workflowId: "workflow-1",
      workflowName: "workflow",
      nodeId: "node-1",
      nodeLabel: "node",
      intent: "execute",
      roleExecutionRevision: null,
      billingContext: { providerId: "openai", credentialSource: "codeflow_key", priceSnapshot: null, capturedAt: 1_000 },
    },
    role: { roleId: "role-1", name: "role", formalTemplateName: "role", inputDefinition: {}, outputDefinition: {} },
    task: { title: "task", goal: "goal", renderedTaskInput: "input", fieldBindings: {} },
    artifacts: { upstreamArtifacts: [], inputReferences: [] },
    knowledge: { catalogs: [], warnings: [] },
    skills: { items: [] },
    review: {},
    runtime: {
      runtimePolicy: {
        workflowId: "workflow-1", workflowName: "workflow", nodeId: "node-1", nodeLabel: "node",
        approvalMode: "auto", executionEngine: "codex", executionProfileMode: "custom",
        executionProfileLabel: "codex:custom", accessMode: "read-only",
        toolRuntimePolicy: { allowedToolIds: [], requiresWorkspaceWrite: false },
        artifactPolicy: { persistenceMode: "db-only", outputMode: "text", primaryKind: null },
      },
      toolRegistry: null,
      executionProfiles: [],
    },
  };
}

/** 构造 candidate Run 的一次性 dispatch 请求。 */
function createRunRequest(
  frozen: ReturnType<ControlledExperimentExecutor["freeze"]>,
  runId: string,
  dispatchToken: string,
): ControlledExperimentRunStartRpcRequest {
  const candidate = frozen.variants.find((variant) => variant.variantKey === "candidate")!;
  const sample = frozen.samples[0]!;
  return {
    contractVersion: 1,
    experimentId: frozen.experimentId,
    runId,
    assignmentId: `assignment-${runId}`,
    sampleId: sample.id,
    variantKey: "candidate",
    attemptNo: 1,
    dispatchToken,
    inputSha256: sample.inputSha256,
    configSha256: candidate.configSha256,
    deadlineAt: Date.now() + 60_000,
  };
}

/** 轮询到本地终态，超时则让测试显式失败。 */
async function waitForTerminal(
  executor: ControlledExperimentExecutor,
  request: ControlledExperimentRunStartRpcRequest,
): Promise<ControlledExperimentRunRpcResult> {
  const dispatchTokenSha256 = sha256Text(request.dispatchToken);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await executor.status({
      contractVersion: 1,
      experimentId: request.experimentId,
      runId: request.runId,
      dispatchTokenSha256,
    });
    if (!result.ok || ["succeeded", "failed", "timed_out", "cancelled"].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`受控实验测试等待终态超时：runId=${request.runId}`);
}

/** 计算 JSON SHA-256。 */
function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

/** 计算文本 SHA-256。 */
function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
