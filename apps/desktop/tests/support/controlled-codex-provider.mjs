import fs from "node:fs/promises";
import path from "node:path";

/** 生成本地协议进程；只读写独占 fixture，不读取认证文件或调用外部模型。 */
export function controlledProvider() {
  const fs = require("node:fs");
  const path = require("node:path");
  const readline = require("node:readline");
  const { randomUUID } = require("node:crypto");
  const directory = path.resolve(__dirname, "../../../..");
  const fixtureFile = path.join(directory, "fixture.json");
  const auditFile = path.join(directory, "audit.jsonl");
  if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.134.0\n");
    return;
  }
  const pending = new Map();
  let requestId = 10_000;

  /** 保存 provider 自身状态，供进程重启后的 thread/read/resume 使用。 */
  function save(thread) { fs.writeFileSync(path.join(directory, `${thread.id}.json`), JSON.stringify(thread), "utf8"); }
  /** 只接受本脚本生成的 provider ID，避免将协议值作为任意路径。 */
  function load(id) {
    assertId(id);
    return JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), "utf8"));
  }
  /** 限制可持久化的 thread ID。 */
  function assertId(id) { if (!/^smoke-[a-f0-9-]+$/.test(id)) throw new Error("invalid provider thread ID"); }
  /** stdout 只承载生产 adapter 消费的 JSON-RPC。 */
  function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
  /** 审计仅保留协议方法和非敏感身份，禁止保存请求正文或环境。 */
  function audit(method, threadId, turnId) {
    fs.appendFileSync(auditFile, `${JSON.stringify({ method, threadId, turnId, pid: process.pid })}\n`, "utf8");
  }
  /** server request 必须等待真实 Client 响应并有界失败。 */
  function request(method, params) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`provider request timeout: ${method}`)); }, 45_000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  /** 平台工具拒绝时立即失败，不输出伪造成功或继续完成 turn。 */
  async function submit(thread, turn, tool, argumentsValue) {
    const result = await request("item/tool/call", { threadId: thread.id, turnId: turn.id, callId: randomUUID(), tool, arguments: argumentsValue });
    const output = JSON.parse(result.contentItems?.find(item => item.type === "inputText")?.text ?? "null");
    if (result.success !== true || output?.ok !== true) throw new Error(`dynamic tool rejected: ${JSON.stringify(output)}`);
    audit(tool, thread.id, turn.id);
  }
  /** 只有真实工具和交互均成功后才发送 provider 完成通知。 */
  function complete(thread, turn, text) {
    turn.items.push({ id: `answer-${turn.id}`, type: "agentMessage", text });
    turn.status = "completed";
    thread.status = { type: "idle" };
    save(thread);
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: turn.items.at(-1) } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn } });
  }
  /** RA 使用 v2 候选补丁，hash 必须从生产提示原样复制。 */
  async function analyze(thread, turn, text, fixture) {
    const hash = text.match(/当前候选集合 hash[：:]\s*([a-f0-9]{24})/)?.[1]
      ?? thread.developerInstructions.match(/baseCandidateSetHash 必须原样提交为 ([a-f0-9]{24})/)?.[1];
    if (!hash) throw new Error("candidate hash absent from production prompt");
    await submit(thread, turn, "aidt_runtime_submitRequirementAnalysisTurnResult", {
      schemaVersion: "requirement-analysis-assistant/v2", baseCandidateSetHash: hash, phase: "confirm",
      conversationSummary: "验证本机独立编排闭环", assistantReply: "已形成可独立验收的本机候选需求。", needUserInput: false, questions: [],
      candidateMutations: [{ op: "create", candidateId: "local-smoke", candidate: {
        title: "本机编排闭环", goal: "完成本机需求到流程的独立验收", background: "受控 JSON-RPC 集成验收",
        acceptanceCriteria: [{ text: "生成可回读的本机验收结果" }], splitSource: "single", complexity: "small", uiScope: "none", architectureRisk: "low",
        recommendedWorkflowId: fixture.workflowId, recommendedWorkflowName: "本机最小验收流程", recommendedWorkflowReason: "单一节点覆盖独立验收目标",
        recommendedApproach: "使用本机单角色流程提交并核对验收结果。", recommendedRoleIds: [fixture.roleId], recommendedKnowledgeBundleIds: [],
        phasingAssessment: { scopeDecision: "fit", deliverySlice: "single-phase", summary: "单一验收闭环", reasoning: "只有一个目标和一个交付物",
          signals: { benefitHypothesisCount: 1, acceptanceLoopCount: 1, actorSurfaceCount: 1, externalSystemCount: 0, newCoreModelCount: 0 }, outOfScope: [] },
        sizeAssessment: { model: "functional-size-v2", summary: "最小验收", reasoning: "一个本机文本结果",
          signals: { functionalProcessCount: 1, domainEntityCount: 1, stateTransitionCount: 1, interactionSurfaceCount: 0, externalIntegrationCount: 0, asyncConsistencyRiskCount: 0, clientSurfaceCount: 1 } },
        assetGaps: [], clarificationItems: [], assumptions: [], openQuestions: [], readyToCreate: true,
      } }], nextAction: { type: "ready-to-create", targetCandidateIds: ["local-smoke"], note: null },
    });
    complete(thread, turn, "本机候选已通过真实平台工具提交。");
  }
  /** 首轮验证原生审批和输入后请求业务反馈，续轮正式交付文本产物。 */
  async function execute(thread, turn) {
    if (thread.turns.length === 1) {
      const approval = await request("item/commandExecution/requestApproval", {
        threadId: thread.id, turnId: turn.id, itemId: `approval-${turn.id}`, command: "echo local-smoke", cwd: process.cwd(),
      });
      if (approval.decision !== "accept") throw new Error("native approval declined");
      audit("approval.accepted", thread.id, turn.id);
      const input = await request("item/tool/requestUserInput", { threadId: thread.id, turnId: turn.id, itemId: `input-${turn.id}`,
        questions: [{ id: "smoke-choice", header: "本机验收输入", question: "请选择本机验收结果", options: [{ label: "确认本机验收", description: "继续本机闭环" }] }] });
      if (!input.answers?.["smoke-choice"]?.answers?.includes("确认本机验收")) throw new Error("native input absent");
      audit("input.accepted", thread.id, turn.id);
      await submit(thread, turn, "aidt_runtime_submitNodeResult", { review: { verdict: "partial", summary: "等待业务反馈" },
        control: { nextAction: "ask_human" }, humanInput: { summary: "请确认业务验收可以继续" }, answer: { mode: "text", text: "等待本机业务反馈" } });
      complete(thread, turn, "本机节点等待业务反馈。");
      return;
    }
    await submit(thread, turn, "aidt_runtime_submitNodeResult", { review: { verdict: "pass", summary: "本机验收完成" },
      control: { nextAction: "continue" }, answer: { mode: "text", text: "本机编排产物：已收到原生审批、原生输入和业务反馈。" },
      acceptanceChecks: [{ label: "生成可回读的本机验收结果", verdict: "pass", blocking: true, evidence: "真实本地工具提交并保存" }] });
    complete(thread, turn, "本机节点正式交付完成。");
  }
  /** 编排沿原夹具执行；普通聊天延迟后重读当前回合，中断不完成，异常交原失败边界。 */
  async function runTurn(thread, turn, params) {
    const text = (params.input ?? []).map(item => item.text ?? "").join("\n");
    const tools = thread.dynamicTools.map(tool => tool.name);
    if (!tools.includes("aidt_runtime_submitRequirementAnalysisTurnResult") && !tools.includes("aidt_runtime_submitNodeResult")) {
      if (text.includes("D06_HOLD_UNTIL_SERVER_STOPS")) {
        audit("chat.held", thread.id, turn.id);
        const deadline = Date.now() + 90_000;
        while (!fs.existsSync(path.join(directory, "release-chat.json"))) {
          if (Date.now() >= deadline) throw new Error("controlled chat release timeout");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
      const currentThread = load(thread.id);
      const currentTurn = currentThread.turns.find(value => value.id === turn.id);
      if (!currentTurn) throw new Error("controlled chat turn absent");
      if (currentTurn.status === "interrupted") return;
      if (currentTurn.status !== "inProgress") throw new Error(`controlled chat turn not running: ${currentTurn.status}`);
      complete(currentThread, currentTurn, "本机受控普通聊天回复。");
      return;
    }
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    if (fixture.hold && tools.includes("aidt_runtime_submitNodeResult")) { audit("turn.held", thread.id, turn.id); return; }
    if (tools.includes("aidt_runtime_submitRequirementAnalysisTurnResult")) await analyze(thread, turn, text, fixture);
    else await execute(thread, turn);
  }
  /** 处理真实 adapter 方法；未知方法返回协议失败，禁止默认伪成功。 */
  async function handle(message) {
    if (!message.method) {
      const operation = pending.get(message.id);
      if (!operation) throw new Error("unknown provider response ID");
      clearTimeout(operation.timer);
      pending.delete(message.id);
      if (message.error) operation.reject(new Error(`client rejected provider request: ${JSON.stringify(message.error)}`));
      else operation.resolve(message.result);
      return;
    }
    if (message.method === "initialized") return;
    const params = message.params ?? {};
    audit(message.method, params.threadId ?? null, params.turnId ?? null);
    if (message.method === "initialize") { send({ id: message.id, result: { userAgent: "codeflow-controlled-smoke" } }); return; }
    if (message.method === "thread/start") {
      const thread = { id: `smoke-${randomUUID()}`, historyMode: "paginated", status: { type: "idle" }, turns: [], dynamicTools: params.dynamicTools ?? [], developerInstructions: params.developerInstructions ?? "" };
      save(thread);
      send({ id: message.id, result: { thread } });
      return;
    }
    if (["thread/resume", "thread/read"].includes(message.method)) {
      const thread = load(params.threadId);
      if (params.developerInstructions != null) thread.developerInstructions = params.developerInstructions;
      save(thread);
      send({ id: message.id, result: { thread } });
      return;
    }
    if (message.method === "thread/goal/get") { send({ id: message.id, result: { goal: null } }); return; }
    if (message.method === "thread/rollback") {
      const thread = load(params.threadId);
      if (thread.status.type !== "idle" || !Number.isSafeInteger(params.numTurns) || params.numTurns < 1 || params.numTurns > thread.turns.length) throw new Error("rollback target invalid");
      thread.turns.splice(thread.turns.length - params.numTurns);
      save(thread);
      send({ id: message.id, result: { thread } });
      return;
    }
    if (message.method === "thread/turns/list") {
      const thread = load(params.threadId);
      const turns = params.sortDirection === "asc" ? [...thread.turns] : [...thread.turns].reverse();
      const offset = params.cursor ? Number(params.cursor) : 0;
      const limit = params.limit ?? 100;
      const data = turns.slice(offset, offset + limit).map(turn => ({ ...turn, itemsView: params.itemsView ?? "full" }));
      send({ id: message.id, result: { data, nextCursor: offset + limit < turns.length ? String(offset + limit) : null } });
      return;
    }
    if (message.method === "thread/items/list") {
      const turn = load(params.threadId).turns.find(value => value.id === params.turnId);
      if (!turn) throw new Error("history turn absent");
      send({ id: message.id, result: { data: turn.items.map(item => ({ turnId: turn.id, item })), nextCursor: null } });
      return;
    }
    if (message.method === "turn/start") {
      const thread = load(params.threadId);
      const turn = { id: `turn-${randomUUID()}`, status: "inProgress", items: [] };
      thread.turns.push(turn);
      thread.status = { type: "active" };
      save(thread);
      send({ id: message.id, result: { turn } });
      send({ method: "turn/started", params: { threadId: thread.id, turn } });
      setTimeout(() => { runTurn(thread, turn, params).catch(error => fail(error, { requestId: message.id, threadId: thread.id, turnId: turn.id })); }, 40);
      return;
    }
    if (message.method === "turn/interrupt") {
      const thread = load(params.threadId);
      const turn = thread.turns.find(value => value.id === params.turnId);
      if (!turn) throw new Error("interrupt target absent");
      turn.status = "interrupted";
      thread.status = { type: "idle" };
      save(thread);
      send({ id: message.id, result: {} });
      send({ method: "turn/completed", params: { threadId: thread.id, turn } });
      return;
    }
    send({ id: message.id, error: { code: -32601, message: `unsupported smoke method: ${message.method}` } });
  }
  /** 错误终止夹具并保留请求身份；JSON解析错误只输出安全原因，避免正文进入诊断。 */
  function fail(error, context = {}) {
    const syntaxError = error instanceof SyntaxError;
    const code = syntaxError ? "CONTROLLED_PROVIDER_INVALID_JSON" : error.code ?? "CONTROLLED_PROVIDER_FAILED";
    const reason = syntaxError ? "controlled provider JSON invalid" : error.message;
    fs.appendFileSync(auditFile, `${JSON.stringify({ method: "fixture.failed", code, ...context, reason, pid: process.pid })}\n`, "utf8");
    process.stderr.write(`controlled provider failed: ${reason}\n`);
    process.exit(1);
  }
  readline.createInterface({ input: process.stdin }).on("line", line => { Promise.resolve().then(() => handle(JSON.parse(line))).catch(fail); });
}

/** PATH 中的 npm 布局经正式 Windows resolver 找到 Node JS 入口。 */
export async function prepareProvider(providerPath) {
  const entry = path.join(providerPath, "node_modules", "@openai", "codex", "bin", "codex.js");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, `(${controlledProvider.toString()})();\n`, "utf8");
  if (process.platform === "win32") await fs.writeFile(path.join(providerPath, "codex.cmd"), "@echo off\r\n", "utf8");
  else {
    const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
    await fs.writeFile(path.join(providerPath, "codex"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, { encoding: "utf8", mode: 0o755 });
  }
}
