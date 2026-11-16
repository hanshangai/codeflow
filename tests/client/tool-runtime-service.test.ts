import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { ExecutableToolDescriptor } from "../../packages/shared/src/index.ts";
import { ManagedServiceRuntime } from "../../apps/desktop/client/src/orchestration/managedServiceRuntime.ts";
import { RuntimeEvidenceService } from "../../apps/desktop/client/src/orchestration/runtimeEvidenceService.ts";
import { ToolRuntimeService } from "../../apps/desktop/client/src/orchestration/toolRuntimeService.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

const fixtureDbs = new Map<string, ClientDb>();

/** 所有直接构造共享本例真实注册 W，并随本例回收。 */
function runtimeOptions(workspacePath: string) {
  const db = fixtureDbs.get(workspacePath); assert.ok(db);
  return { db, workspaceId: "tool-workspace" as any };
}

/** 独占目录内建立注册 W 和普通 SQLite，退出前关闭数据库。 */
function withTempWorkspace(run: (workspacePath: string) => Promise<void> | void): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-tool-runtime-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "fixture.db") });
  db.workspaces.upsert({ id: "tool-workspace" as any, title: "工具", path: workspacePath });
  fixtureDbs.set(workspacePath, db);
  return Promise.resolve(run(workspacePath)).finally(() => {
    fixtureDbs.delete(workspacePath); db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
}

function createTool(overrides: Partial<ExecutableToolDescriptor> = {}): ExecutableToolDescriptor {
  return {
    toolsetId: "toolset-demo" as any,
    toolsetName: "演示工具集",
    toolId: "tool-demo" as any,
    name: "演示工具",
    alias: null,
    description: "测试工具执行",
    runtime: "shell",
    usageGuidance: null,
    invocationHint: null,
    code: "",
    inputSchema: null,
    outputSchema: null,
    timeoutMs: 15_000,
    workingDirectory: ".",
    permissions: {
      requiresWrite: false,
    },
    envPolicy: {
      inheritWorkspaceEnv: true,
      extraEnv: null,
    },
    required: false,
    ...overrides,
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function shellEchoJsonCode(): string {
  if (process.platform === "win32") {
    return [
      '$inputObj = $env:CODEFLOWAI_TOOL_INPUT_JSON | ConvertFrom-Json',
      '$payload = @{ echo = $inputObj.message }',
      '$payload | ConvertTo-Json -Compress',
    ].join("\n");
  }
  return [
    "python - <<'PY'",
    "import json, os",
    "payload = json.loads(os.environ['CODEFLOWAI_TOOL_INPUT_JSON'])",
    "print(json.dumps({'echo': payload['message']}))",
    "PY",
  ].join("\n");
}

test("ToolRuntimeService rejects invalid input before execution", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        runtime: "node",
        code: "printJson({ ok: true });",
        inputSchema: JSON.stringify({
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
          },
        }),
      }),
      {},
      "current",
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TOOL_INPUT_INVALID");
    assert.match(result.message, /\.path/);
  });
});

test("ToolRuntimeService rejects write tools when access mode is insufficient", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        runtime: "shell",
        code: 'Write-Output "{""ok"":true}"',
        permissions: {
          requiresWrite: true,
        },
      }),
      { path: "src/index.ts" },
      "current",
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TOOL_PERMISSION_DENIED");
  });
});

test("ToolRuntimeService executes shell tools and parses JSON output", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        toolId: "shell-tool" as any,
        name: "Shell 工具",
        runtime: "shell",
        code: shellEchoJsonCode(),
        outputSchema: JSON.stringify({
          type: "object",
          required: ["echo"],
          properties: {
            echo: { type: "string" },
          },
        }),
      }),
      { message: "hello-shell" },
      "current",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.output, { echo: "hello-shell" });
  });
});

test("ToolRuntimeService executes python tools and parses JSON output", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        toolId: "python-tool" as any,
        name: "Python 工具",
        runtime: "python",
        code: 'print_json({"echo": INPUT["message"]})',
        outputSchema: JSON.stringify({
          type: "object",
          required: ["echo"],
          properties: {
            echo: { type: "string" },
          },
        }),
      }),
      { message: "hello-python" },
      "current",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.output, { echo: "hello-python" });
  });
});

test("ToolRuntimeService executes node tools and parses JSON output", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        toolId: "node-tool" as any,
        name: "Node 工具",
        runtime: "node",
        code: 'printJson({ echo: INPUT.message });',
        outputSchema: JSON.stringify({
          type: "object",
          required: ["echo"],
          properties: {
            echo: { type: "string" },
          },
        }),
      }),
      { message: "hello-node" },
      "current",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.output, { echo: "hello-node" });
  });
});

const javaAvailable = spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;

test("ToolRuntimeService executes java tools and parses JSON output", { skip: javaAvailable ? false : "java 不可用" }, async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        toolId: "java-tool" as any,
        name: "Java 工具",
        runtime: "java",
        code: [
          "public class ToolMain {",
          "  public static void main(String[] args) {",
          '    System.out.print("{\\"ok\\":true}");',
          "  }",
          "}",
        ].join("\n"),
        outputSchema: JSON.stringify({
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        }),
      }),
      {},
      "current",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.output, { ok: true });
  });
});

test("ToolRuntimeService reports output schema violations", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        toolId: "bad-output-tool" as any,
        name: "错误输出工具",
        runtime: "node",
        code: 'printJson({ echo: 42 });',
        outputSchema: JSON.stringify({
          type: "object",
          required: ["echo"],
          properties: {
            echo: { type: "string" },
          },
        }),
      }),
      {},
      "current",
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TOOL_OUTPUT_INVALID");
    assert.match(result.message, /\.echo/);
  });
});

test("ToolRuntimeService dispatches builtin runtime evidence tools", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const runtimeEvidence = new RuntimeEvidenceService({
      db: {
        orchInstances: {
          get() {
            return null;
          },
        },
        orchArtifacts: {
          listByInstance() {
            return [];
          },
        },
        orchFeedback: {
          listByInstance() {
            return [];
          },
        },
        orchPromptSnapshots: {
          listByInstance() {
            return [];
          },
          listByNode() {
            return [];
          },
        },
        orchEvents: {
          listByInstance() {
            return [];
          },
        },
      } as any,
      instance: {
        id: "orch-runtime" as any,
        workspaceId: "ws" as any,
        workflowId: "wf" as any,
        proposalId: null,
        intakeSnapshot: {
          id: "intake" as any,
          workspaceId: "ws" as any,
          triggerMode: "manual",
          taskType: "analysis",
          title: "检查运行证据",
          goal: "检查运行证据",
          createdAt: 1,
          updatedAt: 1,
        },
        workflowSnapshot: {
          id: "wf" as any,
          workspaceId: "ws" as any,
          name: "运行证据测试",
          description: "",
          nodes: [],
          edges: [],
          version: 1,
        },
        roleSnapshots: {},
        toolsetSnapshots: {},
        runtimeConfig: null,
        artifactIndex: {},
        masterThreadId: "thread-master" as any,
        status: "running",
        nodeStates: {},
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const [runtimeTool] = runtimeEvidence.buildBuiltinTools();
    const service = new ToolRuntimeService(workspacePath, {
      ...runtimeOptions(workspacePath),
      runtimeEvidence,
    });

    const result = await service.execute(runtimeTool, { mode: "summary" }, "read-only");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.output as { mode?: string }).mode, "summary");
    assert.equal((result.output as { workflowName?: string }).workflowName, "运行证据测试");
  });
});

test("ToolRuntimeService rejects unknown builtin tools", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new ToolRuntimeService(workspacePath, runtimeOptions(workspacePath));
    const result = await service.execute(
      createTool({
        toolId: "legacy.unknownBuiltin" as any,
        name: "历史遗留内建工具",
        runtime: "builtin",
        permissions: {
          requiresWrite: false,
        },
      }),
      {},
      "read-only",
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TOOL_EXECUTION_FAILED");
    assert.match(result.message, /未知内建工具/);
  });
});

test("ToolRuntimeService dispatches builtin managed background service tools", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const port = await getFreePort();
    const db = openClientDb({ dbPath: path.join(workspacePath, "application.db") });
    const workspaceId = "tool-managed-workspace" as any;
    db.workspaces.upsert({ id: workspaceId, title: "托管", path: workspacePath });
    db.threads.create({ id: "thread-managed" as any, workspaceId, engine: "codex", title: "托管" });
    const managedServices = new ManagedServiceRuntime({ db });
    const [managedTool] = managedServices.buildBuiltinTools();
    const service = new ToolRuntimeService(workspacePath, {
      db,
      managedServices,
      instanceId: null,
      threadId: "thread-managed",
    });

    const script = [
      "const http = require('node:http');",
      "const port = Number(process.env.TEST_HTTP_PORT);",
      "const server = http.createServer((req, res) => {",
      "  res.writeHead(200, { 'content-type': 'text/plain' });",
      "  res.end('ok');",
      "});",
      "server.listen(port, '127.0.0.1', () => {",
      "  console.log('service ready on ' + port);",
      "});",
    ].join(" ");

    const ensureInput = {
      action: "ensure",
      serviceId: "demo-http",
      command: "node",
      args: ["-e", script],
      env: { TEST_HTTP_PORT: String(port) },
      startupTimeoutMs: 5_000,
      ready: { url: `http://127.0.0.1:${port}/health` },
    };

    try {
      const started = await service.execute(managedTool, ensureInput, "current");
      assert.equal(started.ok, true, JSON.stringify(started));
      if (!started.ok) return;
      assert.equal((started.output as { status?: string }).status, "ready");
      assert.equal((started.output as { reused?: boolean }).reused, false);

      const reused = await service.execute(managedTool, ensureInput, "current");
      assert.equal(reused.ok, true);
      if (!reused.ok) return;
      assert.equal((reused.output as { reused?: boolean }).reused, true);

      const status = await service.execute(managedTool, {
        action: "status",
        serviceId: "demo-http",
      }, "current");
      assert.equal(status.ok, true);
      if (!status.ok) return;
      assert.equal((status.output as { status?: string }).status, "ready");

      const stopped = await service.execute(managedTool, {
        action: "stop",
        serviceId: "demo-http",
      }, "current");
      assert.equal(stopped.ok, true);
      if (!stopped.ok) return;
      assert.equal((stopped.output as { status?: string }).status, "stopped");
      assert.equal((stopped.output as { stopped?: boolean }).stopped, true);

    } finally {
      try { await managedServices.disposeThreadServices("thread-managed" as any); }
      finally { db.close(); }
    }
  });
});

test("ToolRuntimeService builtin diagnostic failure stays explicit and original owner blocks restart", async t => {
  await withTempWorkspace(async workspacePath => {
    const db = openClientDb({ dbPath: path.join(workspacePath, "application.db") }), workspaceId = "tool-log-workspace" as any, threadId = "tool-log-thread" as any;
    db.workspaces.upsert({ id: workspaceId, title: "服务", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "服务" });
    const managedServices = new ManagedServiceRuntime({ db }), tool = managedServices.buildBuiltinTools()[0]!;
    const service = new ToolRuntimeService(workspacePath, { db, managedServices, instanceId: null, threadId });
    const input = { action: "ensure", serviceId: "once", command: process.execPath, args: ["-e", "require('node:fs').appendFileSync('runs.txt','1');setInterval(()=>{},1000)"], ready: { delayMs: 100 } };
    assert.equal((await service.execute(tool, input, "current")).ok, true);
    const record = (managedServices as any).servicesByThread.get(threadId).get("once"), child = record.child, kill = child.kill.bind(child);
    const business = new Error("builtin-stop-root"), logging = new Error("builtin-log-root");
    child.kill = () => { throw business; };
    t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
    try {
      const stopped = await service.execute(tool, { action: "stop", serviceId: "once" }, "current");
      assert.equal(stopped.ok, false);
      if (stopped.ok) throw new Error("expected builtin failure");
      assert.equal(stopped.retryable, false);
      assert.equal(stopped.code, "TOOL_EXECUTION_FAILED");
      let failure: unknown;
      assert.throws(() => managedServices.listThreadServices(threadId), (error: any) => { failure = error; assert.equal(error.errors[0].cause, business); assert.equal(error.errors[1], logging); return true; });
      assert.equal(db.threads.delete(threadId), true);
      assert.equal((await service.execute(tool, input, "current")).ok, false);
      assert.equal(fs.readFileSync(path.join(workspacePath, "runs.txt"), "utf8"), "1");
      child.kill = kill;
      await assert.rejects(managedServices.stopThreadService(threadId, "once"), error => error === failure);
      assert.notEqual(child.exitCode ?? child.signalCode, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => { child.once("exit", resolve); if (!kill()) reject(new Error("builtin cleanup refused")); });
      db.close();
    }
  });
});


