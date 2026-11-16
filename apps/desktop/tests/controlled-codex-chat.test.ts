import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

const providerModule = new URL("./support/controlled-codex-provider.mjs", import.meta.url).href;
type Message = { id?: number; method?: string; params?: any; result?: any; error?: unknown };

/** 创建后即注册回收；真实Node/stdio关闭后才删除独占夹具根。 */
async function provider(t: TestContext, options: { withoutFixture?: boolean; fixture?: object } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-controlled-chat-"));
  let ownedChild: ChildProcess | undefined;
  t.after(async () => {
    if (ownedChild) {
      if (ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill();
      await exit();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  // 原生装载保留toString的自包含函数，避免tsx插入外部__name依赖。
  execFileSync(process.execPath, ["--input-type=module", "--eval",
    `const { prepareProvider } = await import(${JSON.stringify(providerModule)}); await prepareProvider(process.argv[1]);`, root], { windowsHide: true });
  if (!options.withoutFixture) await fs.writeFile(path.join(root, "fixture.json"), JSON.stringify(options.fixture ?? {}), "utf8");
  const entry = path.join(root, "node_modules/@openai/codex/bin/codex.js");
  const child = spawn(process.execPath, [entry, "app-server"], { stdio: "pipe", windowsHide: true });
  ownedChild = child;
  const closed = once(child, "close");
  let stdout = "", stderr = "", sequence = 0;
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });

  /** 只解析已收齐的JSON行；半行仍属于在途数据，不提前当作坏JSON。 */
  function messages(): Message[] { return stdout.split("\n").slice(0, -1).map(line => JSON.parse(line)); }
  /** 轮询实际协议事实，子进程失败或期限耗尽均明确拒绝。 */
  async function wait<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label}: provider exited ${child.exitCode}; ${stderr}`);
      await delay(20);
    }
    throw new Error(`${label}: timed out; ${stderr}`);
  }
  /** 发送真实请求并匹配原请求ID，不把通知或其他响应误当成功。 */
  async function request(method: string, params: object = {}) {
    const id = ++sequence;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const response = await wait(() => messages().find(message => message.id === id && !message.method), method);
    assert.equal(response.error, undefined);
    return { id, result: response.result };
  }
  /** 回复provider原生请求；只提供此协议测试规定的Client结果。 */
  function respond(message: Message, result: object) {
    assert.equal(typeof message.id, "number");
    child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }
  /** 等待真正close事件，避免以exitCode更新代替stdio释放。 */
  async function exit() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PROVIDER_CLOSE_TIMEOUT")), 6500);
      })]);
    } finally { clearTimeout(timer); }
  }
  /** 回读已初始化后必定存在的审计文件，不吞读取或JSON错误。 */
  async function audit() { return (await fs.readFile(path.join(root, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
  /** 启动回合并确认原started通知，返回请求及回合身份。 */
  async function start(threadId: string) {
    const { id, result } = await request("turn/start", { threadId, input: [{ type: "text", text: "controlled chat" }] });
    await wait(() => messages().find(message => message.method === "turn/started" && message.params.turn.id === result.turn.id), "turn/started");
    return { requestId: id, turnId: result.turn.id };
  }
  /** 仅匹配指定回合的终态通知。 */
  async function completed(turnId: string) {
    return await wait(() => messages().find(message => message.method === "turn/completed" && message.params.turn.id === turnId), "turn/completed");
  }
  await request("initialize");
  return { root, child, messages, wait, request, respond, exit, audit, start, completed, stderr: () => stderr };
}

test("ordinary chat completes and persists without orchestration fixture.json", async t => {
  const p = await provider(t, { withoutFixture: true });
  const { result: { thread } } = await p.request("thread/start");
  const { turnId } = await p.start(thread.id);
  const done = await p.completed(turnId);
  assert.equal(done.params.turn.status, "completed");
  assert.equal(done.params.turn.items[0].text, "本机受控普通聊天回复。");
  const { result } = await p.request("thread/read", { threadId: thread.id });
  assert.equal(result.thread.status.type, "idle");
  assert.equal(result.thread.turns[0].id, turnId);
  assert.equal(result.thread.turns[0].items.length, 1);
  assert.equal(p.messages().filter(message => message.method === "item/completed").length, 1);
});

test("interrupt followed by another chat preserves interruption and completes only its successor", async t => {
  const p = await provider(t);
  const { result: { thread } } = await p.request("thread/start");
  const first = await p.start(thread.id);
  await p.request("turn/interrupt", { threadId: thread.id, turnId: first.turnId });
  const second = await p.start(thread.id);
  await p.completed(second.turnId);
  const { result } = await p.request("thread/read", { threadId: thread.id });
  assert.deepEqual(result.thread.turns.map((turn: any) => ({ id: turn.id, status: turn.status, items: turn.items.length })), [
    { id: first.turnId, status: "interrupted", items: 0 }, { id: second.turnId, status: "completed", items: 1 },
  ]);
  assert.deepEqual(p.messages().filter(message => message.method === "item/completed").map(message => message.params.turnId), [second.turnId]);
});

test("delayed chat completion preserves thread metadata updated during the turn", async t => {
  const p = await provider(t);
  const { result: { thread } } = await p.request("thread/start", { developerInstructions: "before" });
  const { turnId } = await p.start(thread.id);
  await p.request("thread/resume", { threadId: thread.id, developerInstructions: "updated while waiting" });
  await p.completed(turnId);
  const { result } = await p.request("thread/read", { threadId: thread.id });
  assert.equal(result.thread.developerInstructions, "updated while waiting");
  assert.equal(result.thread.turns[0].status, "completed");
});

test("delayed persistence failures terminate explicitly with request and entity context", async t => {
  for (const fault of ["missing-file", "invalid-json", "missing-turn", "invalid-status"]) await t.test(fault, async subtest => {
    const p = await provider(subtest);
    const { result: { thread } } = await p.request("thread/start");
    const { requestId, turnId } = await p.start(thread.id);
    const file = path.join(p.root, `${thread.id}.json`);
    if (fault === "missing-file") await fs.unlink(file);
    else if (fault === "invalid-json") await fs.writeFile(file, "CHATBODY", "utf8");
    else {
      const persisted = JSON.parse(await fs.readFile(file, "utf8"));
      if (fault === "missing-turn") persisted.turns = [];
      else persisted.turns[0].status = "unexpected-status";
      await fs.writeFile(file, JSON.stringify(persisted), "utf8");
    }
    assert.equal((await p.exit())[0], 1);
    const failures = (await p.audit()).filter((row: any) => row.method === "fixture.failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].requestId, requestId);
    assert.equal(failures[0].threadId, thread.id);
    assert.equal(failures[0].turnId, turnId);
    assert.equal(typeof failures[0].code, "string");
    assert.equal(typeof failures[0].reason, "string");
    if (fault === "invalid-json") {
      assert.equal(JSON.stringify(failures).includes("CHATBODY"), false);
      assert.equal(p.stderr().includes("CHATBODY"), false);
      assert.equal(failures[0].code, "CONTROLLED_PROVIDER_INVALID_JSON");
    }
    assert.equal(p.messages().filter(message => ["item/completed", "turn/completed"].includes(message.method ?? "")).length, 0);
  });
});

test("provider preparation failure removes its own temporary directory", async t => {
  const mkdtemp = fs.mkdtemp.bind(fs);
  let createdRoot = "";
  t.after(async () => { if (createdRoot) await fs.rm(createdRoot, { recursive: true, force: true }); });
  t.mock.method(fs, "mkdtemp", async (prefix: string) => {
    createdRoot = await mkdtemp(prefix);
    return createdRoot;
  });
  await t.test("fixture serialization fails before the provider is spawned", async subtest => {
    await assert.rejects(provider(subtest, { fixture: { invalid: 1n } }), /BigInt/);
  });
  assert.notEqual(createdRoot, "");
  await assert.rejects(fs.stat(createdRoot), { code: "ENOENT" });
});

test("orchestration hold still requires its fixture and remains interruptible", async t => {
  const p = await provider(t, { fixture: { hold: true } });
  const { result: { thread } } = await p.request("thread/start", { dynamicTools: [{ name: "aidt_runtime_submitNodeResult" }] });
  const { turnId } = await p.start(thread.id);
  await p.wait(async () => (await p.audit()).find((row: any) => row.method === "turn.held" && row.turnId === turnId), "turn.held");
  await p.request("turn/interrupt", { threadId: thread.id, turnId });
  assert.equal((await p.completed(turnId)).params.turn.status, "interrupted");
  assert.equal(p.messages().some(message => message.method === "item/completed"), false);
});

test("missing orchestration fixture fails instead of falling through to ordinary chat", async t => {
  const p = await provider(t, { withoutFixture: true });
  const { result: { thread } } = await p.request("thread/start", { dynamicTools: [{ name: "aidt_runtime_submitNodeResult" }] });
  const { turnId } = await p.start(thread.id);
  assert.equal((await p.exit())[0], 1);
  assert.equal(p.messages().some(message => message.method === "item/completed" && message.params.turnId === turnId), false);
});

test("orchestration still completes after its native approval, input and dynamic tool response", async t => {
  const p = await provider(t);
  const { result: { thread } } = await p.request("thread/start", { dynamicTools: [{ name: "aidt_runtime_submitNodeResult" }] });
  const { turnId } = await p.start(thread.id);
  const approval = await p.wait(() => p.messages().find(message => message.method === "item/commandExecution/requestApproval"), "approval");
  p.respond(approval, { decision: "accept" });
  const input = await p.wait(() => p.messages().find(message => message.method === "item/tool/requestUserInput"), "input");
  p.respond(input, { answers: { "smoke-choice": { answers: ["确认本机验收"] } } });
  const tool = await p.wait(() => p.messages().find(message => message.method === "item/tool/call"), "dynamic tool");
  assert.equal(tool.params.tool, "aidt_runtime_submitNodeResult");
  assert.equal(tool.params.arguments.control.nextAction, "ask_human");
  p.respond(tool, { success: true, contentItems: [{ type: "inputText", text: '{"ok":true}' }] });
  assert.equal((await p.completed(turnId)).params.turn.status, "completed");
  assert.equal(p.messages().filter(message => message.method === "item/completed").length, 1);
});
