import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/** 独立临时工作区测量真实Client API和事件持久化；不启动模型或访问用户数据。 */
async function worker(root: string): Promise<void> {
  const { openClientDb } = await import("../src/db/clientDb.js");
  const { executeDesktopApiRequest } = await import("../src/app/executeDesktopApiRequest.js");
  const { createLocalEventPersistence } = await import("../src/runtime/localEventPersistence.js");
  const { ThreadStore } = await import("../src/threads/threadStore.js");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
  fs.writeFileSync(path.join(project, "note.txt"), "desktop benchmark\n");
  execFileSync("git", ["add", "note.txt"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@local", "commit", "-qm", "fixture"], { cwd: project, stdio: "ignore" });
  for (let index = 0; index < 240; index++) fs.writeFileSync(path.join(project, `source-${index}.txt`), "content");
  for (let index = 0; index < 32; index++) fs.mkdirSync(path.join(project, `directory-${index}`));
  const db = openClientDb({ dbPath: path.join(root, "application.db"), localCanonicalEvents: true });
  const workspaceId = "bench:workspace", threadId = "bench-thread";
  db.workspaces.upsert({ id: workspaceId, title: "Benchmark", path: project });
  const view = db.forWorkspace(workspaceId);
  view.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Benchmark" });
  const writer = createLocalEventPersistence({ db, applyRaw() {}, applyConversation(event) {
    assert.equal(view.threads.get(event.threadId)?.workspaceId, workspaceId);
  } });
  const ctx = { db, clientId: "bench", workspaces: new Map([[workspaceId, project]]), threads: new ThreadStore(),
    send() { throw new Error("UNEXPECTED_REMOTE_SEND"); } } as any;
  let loading = false, events = 0, stopping = false;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  /** 每轮保留raw和canonical真实提交，主动让出以观测其他IPC响应。 */
  const produce = (): void => {
    if (!loading || stopping) return;
    const ts = Date.now();
    writer.persist({ t: "raw.event", event: { workspaceId, threadId, engine: "codex", ts, source: "benchmark", data: { text: "x".repeat(256) }, handled: true, action: "mapped", emittedTypes: [] } });
    writer.persist({ t: "conversation.event", event: { workspaceId, threadId, engine: "codex", ts, type: "item.agentMessage.delta", payload: { itemId: "bench-message", delta: "x" } } as any });
    events += 2;
    setImmediate(produce);
  };
  process.on("message", async (input: any) => {
    try {
      if (input.action === "load") { loading = true; produce(); process.send!({ id: input.id, ok: true }); return; }
      if (input.action === "stop") {
        loading = false; stopping = true; lag.disable(); db.close();
        process.send!({ id: input.id, ok: true, events, lagP95Ms: lag.percentile(95) / 1e6, lagMaxMs: lag.max / 1e6 }, () => process.disconnect!());
        return;
      }
      const response = await executeDesktopApiRequest(ctx, input.request, { requestId: String(input.id), clientVersion: "benchmark", startedAt: 1 });
      process.send!({ id: input.id, response });
    } catch (error) {
      process.send!({ id: input.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  process.send!({ ready: true, workspaceId, threadId });
}

/** 用真实子进程IPC统计空闲/持续输出时各业务请求分布，超时或失败使基准非零退出。 */
async function main(entry = fileURLToPath(import.meta.url), variant = "workspace"): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-interaction-bench-"));
  const child = fork(entry, ["--worker", root], { execArgv: ["--conditions=development", "--import", "tsx"],
    env: { ...process.env, CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs") }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const ready = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("BENCHMARK_STARTUP_TIMEOUT")), 30_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.on("message", (message: any) => {
      if (message.ready) { clearTimeout(timeout); resolve(message); return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error)) : entry.resolve(message);
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      const failure = new Error(`BENCHMARK_CHILD_EXIT:${code}`);
      reject(failure);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
      pending.clear();
    });
  });
  /** 请求必须在预算内收到对应结果；失败不计入成功延迟。 */
  const request = (value: object): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("BENCHMARK_IPC_TIMEOUT")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.send({ ...value, id }, error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
  });
  try {
    const { workspaceId, threadId } = await ready;
    const requests = [
      { method: "runtime.info" },
      { method: "threads.list", body: { workspaceId } },
      { method: "threads.load", body: { workspaceId, threadId, presentation: "lazy" } },
      { method: "git.status", body: { workspaceId } },
      { method: "git.log", body: { workspaceId, maxCount: 20 } },
      { method: "fs.tree", body: { workspaceId, depth: 1 } },
      { method: "fs.readFile", body: { workspaceId, path: "note.txt" } },
    ];
    for (const mode of ["idle", "events"] as const) {
      if (mode === "events") await request({ action: "load" });
      const durations = new Map(requests.map(item => [item.method, [] as number[]]));
      for (let round = 0; round < 12; round++) await Promise.all(requests.map(async item => {
        const start = performance.now(), result = await request({ request: item });
        assert.equal(result.response.status, 200, `${item.method}: ${JSON.stringify(result.response.body)}`);
        durations.get(item.method)!.push(performance.now() - start);
      }));
      console.log(JSON.stringify({ variant, mode, requests: 84, results: [...durations].map(([method, values]) => {
        values.sort((a, b) => a - b);
        return { method, medianMs: Math.round(values[5]!), p95Ms: Math.round(values[11]!), maxMs: Math.round(values.at(-1)!) };
      }) }));
    }
    console.log(JSON.stringify({ variant, workload: await request({ action: "stop" }) }));
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null && !child.killed) { child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 同机生成提交基线与当前源码两个隔离入口；源码替换仅发生在构建内存，不改工作区。 */
async function compare(): Promise<void> {
  const { build } = await import("esbuild");
  const repo = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-interaction-compare-"));
  const baselineFiles = ["src/db/clientDb.ts", "src/codeflowai/workspaceCodeflowaiDirectory.ts", "src/runtime/localEventPersistence.ts", "src/fs/fsService.ts", "src/app/handlers/fsHandlers.ts"];
  const baseline = new Map(baselineFiles.map(file => [path.join(repo, "apps/desktop/client", file),
    execFileSync("git", ["show", `HEAD:apps/desktop/client/${file}`], { cwd: repo, encoding: "utf8", maxBuffer: 2_000_000 })]));
  try {
    for (const variant of ["committed-baseline", "workspace"] as const) {
      const outfile = path.join(directory, `${variant}.mjs`);
      await build({ entryPoints: [fileURLToPath(import.meta.url)], outfile, bundle: true, platform: "node", format: "esm", packages: "external",
        banner: { js: "import { createRequire as benchmarkRequire } from 'node:module';const require = benchmarkRequire(import.meta.url);" },
        plugins: [{ name: "interaction-benchmark-source", setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, args => {
            if (!args.importer || args.path.startsWith("node:")) return;
            const resolved = createRequire(args.importer).resolve(args.path);
            if (args.path === "simple-git") return { path: resolved };
            return { path: args.kind === "require-call" ? resolved : pathToFileURL(resolved).href, external: true };
          });
          if (variant === "committed-baseline") builder.onLoad({ filter: /\.ts$/ }, args => {
            const contents = baseline.get(args.path);
            return contents === undefined ? undefined : { contents, loader: "ts", resolveDir: path.dirname(args.path) };
          });
        } }],
      });
      await main(outfile, variant);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

await (process.argv[2] === "--worker" ? worker(process.argv[3]!) : process.argv[2] === "--compare" ? compare() : main());
