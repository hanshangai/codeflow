import net, { type Socket, type Server } from "node:net";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants, rename as renameCallback, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export type ShellUpdateFileRoot = { root: string; dev: string; ino: string };
export type ShellUpdateFileRequest = { kind: "read" } | { kind: "checkExpected"; expected: unknown }
  | { kind: "replace"; expected: unknown; next: unknown };
type Execute = (request: ShellUpdateFileRequest) => Promise<unknown>;
export type ShellUpdateFileOwnerScope = { assertActive(): void; release(): Promise<void> };
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
type Job = { request: ShellUpdateFileRequest; execute: Execute; deadline: number; alive(): boolean;
  local: boolean; finish(outcome: Outcome): void };
type Owner = { id: string; expiresAt: number; stopping: boolean; error?: unknown; timer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>; completed: Deferred<Outcome>; release?: Promise<void> };
type Epoch = { root: ShellUpdateFileRoot; pipe: string; server: Server; execute: Execute;
  state: "accepting" | "draining" | "poisoned" | "closed"; ready: Promise<boolean>; closed: Deferred<void>;
  reads: Job[]; writes: Job[]; active: boolean; peers: Set<Socket>; buffered: number; pending: number;
  locals: { result: Deferred<Outcome>; outcome: Outcome }[]; poison?: unknown; closing: boolean; owner?: Owner };

const PROTOCOL = 1, CONTRACT = "shell-update-attempt-physical-1";
const MAX_FRAME = 4 * 1024 * 1024, MAX_BUFFERED = 16 * 1024 * 1024, MAX_PENDING = 256, BUDGET = 30_000;
const epochs = new Map<string, Epoch>();
const AUTH_DIRECTORY = ".shell-update-file-auth";
const CAPABILITY_DIRECTORY_PREFIX = ".shell-update-file-capability-";
const ATTEMPT_FILENAME = "shell-update-attempt.json";
const execFile = promisify(execFileCallback);
const renameNative = promisify(renameCallback);
const openNative = fs.open.bind(fs), mkdirNative = fs.mkdir.bind(fs), lstatNative = fs.lstat.bind(fs);
const unlinkNative = fs.unlink.bind(fs), rmdirNative = fs.rmdir.bind(fs);
const authKeys = new Map<string, { key: Buffer; directory: BigIntStats; file: BigIntStats }>();

/** Resolve only explicit completion; failed jobs retain their original local error. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(accept => { resolve = accept; }), resolve: value => resolve(value) };
}

/** Directory identity, not a path alias or protocol version, selects the one owner. */
function pipeName(root: ShellUpdateFileRoot): string {
  if (!root || typeof root.root !== "string" || !root.root || !/^[0-9]+$/u.test(root.dev) || !/^[1-9][0-9]*$/u.test(root.ino)) {
    throw failure("ROOT_INVALID");
  }
  return `\\\\.\\pipe\\codeflowai-shell-update-attempt-${crypto.createHash("sha256").update(`${root.dev}:${root.ino}`).digest("hex")}`;
}

/** Coordinate already copied physical requests; no caller opens the attempt after a permit. */
export async function coordinateShellUpdateFile<T>(root: ShellUpdateFileRoot, request: ShellUpdateFileRequest,
  execute: (request: ShellUpdateFileRequest) => Promise<T>, beforeSend?: () => Promise<void>): Promise<T> {
  if (process.platform !== "win32") throw failure("PLATFORM_UNSUPPORTED");
  validateRequest(request);
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_FRAME - 1024) throw failure("FRAME_INVALID");
  const pipe = pipeName(root), deadline = Date.now() + BUDGET;
  while (Date.now() < deadline) {
    let epoch = epochs.get(pipe);
    if (!epoch) {
      epoch = createEpoch(root, pipe, execute);
      epochs.set(pipe, epoch);
    }
    assertEpochHealthy(epoch);
    if (await epoch.ready) {
      if (!sameRoot(root, epoch.root)) throw failure("ROOT_MISMATCH");
      assertEpochHealthy(epoch);
      if (epoch.owner) assertOwnerActive(epoch, epoch.owner);
      if (epoch.state === "accepting") {
        const result = deferred<Outcome>();
        enqueue(epoch, { request, execute, deadline, alive: () => true, local: true,
          finish: outcome => { if (epoch!.owner) result.resolve(outcome); else epoch!.locals.push({ result, outcome }); } });
        const outcome = await result.promise;
        if (!outcome.ok) throw outcome.error;
        return outcome.value as T;
      }
      await epoch.closed.promise;
    } else {
      const remote = await remoteRequest(pipe, root, request, deadline, beforeSend);
      if (remote !== undefined) return remote as T;
      await delay(1);
    }
  }
  throw failure("DEADLINE_EXCEEDED");
}

/** Recheck mutable epoch health across awaited startup without losing the original poison cause. */
function assertEpochHealthy(epoch: Epoch): void {
  if (epoch.state === "poisoned") throw failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false });
}

/** Own the existing physical queue across idle waits without retaining a physical file handle. */
export async function acquireShellUpdateFileOwner(root: ShellUpdateFileRoot, execute: Execute,
  timeoutMs: number): Promise<ShellUpdateFileOwnerScope> {
  if (process.platform !== "win32") throw failure("PLATFORM_UNSUPPORTED");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("OWNER_TIMEOUT_INVALID");
  const pipe = pipeName(root), deadline = Date.now() + BUDGET;
  while (Date.now() < deadline) {
    const existing = epochs.get(pipe);
    if (existing) {
      if (!sameRoot(root, existing.root)) throw failure("ROOT_MISMATCH");
      if (existing.state === "poisoned") throw failure("ROOT_POISONED", existing.poison, { resourcesReleased: false });
      throw failure("OWNER_BUSY");
    }
    const epoch = createEpoch(root, pipe, execute);
    const owner: Owner = { id: crypto.randomUUID(), expiresAt: Infinity, stopping: false, completed: deferred<Outcome>() };
    epoch.owner = owner; epochs.set(pipe, epoch);
    if (!await epoch.ready) { await delay(1); continue; }
    if (epoch.state === "poisoned") throw failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false });
    if (Date.now() >= deadline) {
      stopOwner(epoch, owner, ownerFailure(epoch, owner, "DEADLINE_EXCEEDED"));
      await releaseOwner(epoch, owner);
      throw owner.error;
    }
    owner.expiresAt = Date.now() + timeoutMs;
    scheduleOwnerExpiry(epoch, owner);
    return {
      /** Fail before a caller performs further business side effects outside the physical queue. */
      assertActive: () => assertOwnerActive(epoch, owner),
      /** Repeated release observes the same cleanup result, including an expired scope. */
      release: () => owner.release ??= releaseOwner(epoch, owner)
    };
  }
  throw failure("DEADLINE_EXCEEDED");
}

/** Long finite scopes rearm the native timer instead of expiring at Node's timer limit. */
function scheduleOwnerExpiry(epoch: Epoch, owner: Owner): void {
  owner.timer = setTimeout(() => {
    if (Date.now() >= owner.expiresAt) stopOwner(epoch, owner, ownerFailure(epoch, owner, "OWNER_SCOPE_EXPIRED"));
    else scheduleOwnerExpiry(epoch, owner);
  }, Math.min(Math.max(1, owner.expiresAt - Date.now()), 2_147_483_647));
  owner.timer.unref();
}

/** Expiry is checked synchronously as well as by timer so busy event loops cannot admit late work. */
function assertOwnerActive(epoch: Epoch, owner: Owner): void {
  if (!owner.stopping && Date.now() >= owner.expiresAt) stopOwner(epoch, owner, ownerFailure(epoch, owner, "OWNER_SCOPE_EXPIRED"));
  if (epoch.state === "poisoned") throw failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false });
  if (owner.stopping || epoch.state !== "accepting") throw owner.error ?? ownerFailure(epoch, owner, "OWNER_SCOPE_RELEASED");
}

/** Reuse transport-supported fields to correlate scope failures without exposing authentication data. */
function ownerFailure(epoch: Epoch, owner: Owner, suffix: string): Error {
  return failure(suffix, undefined, { requestId: owner.id, path: epoch.root.root, phase: "owner-scope" });
}

/** Stop admission immediately, then retain the epoch until actual jobs and connections finish. */
function stopOwner(epoch: Epoch, owner: Owner, cause?: unknown): void {
  if (owner.stopping) return;
  owner.stopping = true; owner.error = cause;
  clearTimeout(owner.timer);
  if (epoch.state === "accepting") epoch.state = "draining";
  owner.closeTimer = setTimeout(() => poison(epoch, failure("CLOSE_TIMEOUT", undefined, { resourcesReleased: false })), BUDGET);
  owner.closeTimer.unref();
  void pump(epoch); closeIfDrained(epoch);
}

/** Cleanup errors stay explicit; an in-flight operation is never raced against a release timeout. */
async function releaseOwner(epoch: Epoch, owner: Owner): Promise<void> {
  stopOwner(epoch, owner);
  let rootFailure: { cause: unknown } | undefined;
  try { await assertAuthRoot(epoch.root); }
  catch (cause) { rootFailure = { cause }; }
  const outcome = await owner.completed.promise;
  if (epoch.state === "closed" && epochs.get(epoch.pipe) === epoch) epochs.delete(epoch.pipe);
  if (rootFailure && !outcome.ok) throw new AggregateError([rootFailure.cause, outcome.error], "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_RELEASE_FAILED");
  if (rootFailure) throw rootFailure.cause;
  if (!outcome.ok) throw outcome.error;
}

/** Bind exclusively before admitting any work; a collision never authorizes direct file I/O. */
function createEpoch(root: ShellUpdateFileRoot, pipe: string, execute: Execute): Epoch {
  const server = net.createServer();
  const epoch: Epoch = { root: { ...root }, pipe, server, execute, state: "accepting", ready: Promise.resolve(false),
    closed: deferred<void>(), reads: [], writes: [], active: false, peers: new Set(), buffered: 0, pending: 0, locals: [], closing: false };
  epoch.ready = new Promise<boolean>((resolve, reject) => {
    /** A bind collision is the sole expected election outcome. */
    const onBindError = (cause: Error & { code?: string }) => {
      if (epochs.get(pipe) === epoch) epochs.delete(pipe);
      epoch.state = "closed"; epoch.closed.resolve();
      if (cause.code === "EADDRINUSE") resolve(false);
      else reject(failure("LISTEN_FAILED", cause));
    };
    server.once("error", onBindError);
    server.listen({ path: pipe, exclusive: true }, () => {
      server.removeListener("error", onBindError);
      server.on("error", cause => poison(epoch, failure("LISTEN_FAILED", cause)));
      server.unref();
      void authenticationKey(root, true).then(() => capabilityPreflight(root)).then(() => resolve(true), cause => {
        if (unreleased(cause)) { poison(epoch, cause); resolve(true); }
        else {
          epoch.state = "draining"; epoch.closing = true;
          for (const socket of epoch.peers) socket.destroy();
          let settled = false;
          const timer = setTimeout(() => {
            settled = true;
            const error = failure("CLOSE_TIMEOUT", cause, { resourcesReleased: false });
            poison(epoch, error); reject(error);
          }, BUDGET);
          server.close(close => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (close) {
              const error = failure("CLOSE_FAILED", new AggregateError([cause, close], "DESKTOP_SHELL_UPDATE_COORDINATOR_CLOSE_FAILED"), { resourcesReleased: false });
              poison(epoch, error); reject(error);
            } else {
              epoch.state = "closed";
              if (epochs.get(pipe) === epoch) epochs.delete(pipe);
              epoch.closed.resolve(); reject(cause);
            }
          });
        }
      });
    });
  });
  server.on("connection", socket => {
    socket.on("error", () => { /* Per-request receive/send owns and propagates this socket failure. */ });
    if (epoch.state === "draining" || epoch.state === "closed") { socket.destroy(); return; }
    if (epoch.peers.size + epoch.pending >= MAX_PENDING) {
      void send(socket, { kind: "error", error: encodeError(failure("CAPACITY_EXCEEDED")) })
        .catch(cause => logFailure(epoch, cause)).finally(() => socket.destroy());
      return;
    }
    epoch.peers.add(socket);
    void serve(epoch, socket).catch(cause => logFailure(epoch, cause)).finally(() => {
      epoch.peers.delete(socket); socket.destroy(); closeIfDrained(epoch);
    });
  });
  return epoch;
}

/** Two FIFO queues make a waiting writer visible across all store instances. */
function enqueue(epoch: Epoch, job: Job): void {
  if (epoch.owner) assertOwnerActive(epoch, epoch.owner);
  if (epoch.pending >= MAX_PENDING) throw failure("CAPACITY_EXCEEDED");
  epoch.pending++;
  (job.request.kind === "read" ? epoch.reads : epoch.writes).push(job);
  void pump(epoch);
}

/** Finish actual I/O and cleanup before selecting any successor or releasing the listener. */
async function pump(epoch: Epoch): Promise<void> {
  if (epoch.active) return;
  epoch.active = true;
  try {
    while (epoch.writes.length || epoch.reads.length) {
      const job = (epoch.writes.length ? epoch.writes : epoch.reads).shift()!;
      let outcome: Outcome;
      if (epoch.state === "poisoned") outcome = { ok: false, error: failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false }) };
      else if (!job.alive()) outcome = { ok: false, error: failure("REQUEST_DISCONNECTED") };
      else if (Date.now() >= job.deadline) outcome = { ok: false, error: failure("DEADLINE_EXCEEDED") };
      else {
        try {
          if (epoch.owner) { assertOwnerActive(epoch, epoch.owner); await assertAuthRoot(epoch.root); assertOwnerActive(epoch, epoch.owner); }
          outcome = { ok: true, value: await job.execute(job.request) };
        }
        catch (error) {
          outcome = { ok: false, error };
          if (unreleased(error)) poison(epoch, error);
        }
      }
      epoch.pending--; job.finish(outcome);
      if (job.local && !epoch.owner && epoch.state === "accepting") epoch.state = "draining";
    }
  } finally {
    epoch.active = false;
    if (epoch.state === "poisoned") settleLocals(epoch);
    closeIfDrained(epoch);
  }
}

/** Unknown handle ownership blocks this root while the process and other roots stay alive. */
function poison(epoch: Epoch, cause: unknown): void {
  epoch.state = "poisoned"; epoch.poison = cause;
  if (!epoch.active) { void pump(epoch); settleLocals(epoch); }
}

/** Local results return only after idle close, preserving spawnSync callers. */
function closeIfDrained(epoch: Epoch): void {
  if (epoch.active || epoch.pending || epoch.peers.size) return;
  if (epoch.owner && epoch.state === "poisoned") {
    clearTimeout(epoch.owner.timer); clearTimeout(epoch.owner.closeTimer);
    const poisoned = failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false });
    epoch.owner.completed.resolve({ ok: false, error: epoch.owner.error === undefined ? poisoned
      : new AggregateError([epoch.owner.error, poisoned], "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_RELEASE_FAILED") });
    return;
  }
  if (epoch.state !== "draining" || epoch.closing) return;
  epoch.closing = true;
  epoch.server.close(cause => {
    if (cause) { poison(epoch, failure("CLOSE_FAILED", cause, { resourcesReleased: false })); return; }
    epoch.state = "closed";
    if (!epoch.owner && epochs.get(epoch.pipe) === epoch) epochs.delete(epoch.pipe);
    epoch.closed.resolve(); settleLocals(epoch);
    if (epoch.owner) {
      clearTimeout(epoch.owner.timer); clearTimeout(epoch.owner.closeTimer);
      epoch.owner.completed.resolve(epoch.owner.error === undefined ? { ok: true, value: undefined } : { ok: false, error: epoch.owner.error });
    }
  });
}

/** Settle once without translating a local business error into a transport error. */
function settleLocals(epoch: Epoch): void {
  for (const item of epoch.locals.splice(0)) {
    if (epoch.state !== "poisoned" || !item.outcome.ok && (item.outcome.error === epoch.poison
      || nativeCode(item.outcome.error, ["DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED"]))) item.result.resolve(item.outcome);
    else item.result.resolve({ ok: false, error: item.outcome.ok ? failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false })
      : new AggregateError([item.outcome.error, epoch.poison], "DESKTOP_SHELL_UPDATE_COORDINATOR_CLOSE_FAILED") });
  }
}

/** Admit a bounded connection before it sends a single business request. */
async function serve(epoch: Epoch, socket: Socket): Promise<void> {
  const deadline = Date.now() + BUDGET;
  let id: string | undefined, charged = 0, admitted = false;
  try {
    if (!await epoch.ready) throw failure("OWNER_UNAVAILABLE");
    const reserve = (bytes: number) => {
      if (epoch.buffered + bytes > MAX_BUFFERED) throw failure("CAPACITY_EXCEEDED");
      epoch.buffered += bytes; charged += bytes;
    };
    const hello = record(await receive(socket, deadline, reserve), ["kind", "protocol", "contract", "id", "root", "nonce"]);
    id = correlation(hello.id);
    if (hello.kind !== "hello" || hello.protocol !== PROTOCOL || hello.contract !== CONTRACT) throw failure("PROTOCOL_MISMATCH");
    if (!sameRoot(readRoot(hello.root), epoch.root)) throw failure("ROOT_MISMATCH");
    if (epoch.state === "poisoned") throw failure("ROOT_POISONED", epoch.poison, { resourcesReleased: false });
    if (epoch.state !== "accepting") { await send(socket, { kind: "busy", id }); return; }
    admitted = true;
    const key = await authenticationKey(epoch.root, false), serverNonce = crypto.randomBytes(32).toString("hex");
    const context = authContext(epoch.root, crypto.randomUUID(), id, nonce(hello.nonce), serverNonce);
    await send(socket, { kind: "challenge", id, epoch: context[3], nonce: serverNonce, proof: mac(key, context, "server", null) });
    const client = record(await receive(socket, deadline, reserve), ["kind", "id", "proof"]);
    if (client.kind !== "proof" || client.id !== id) throw failure("CORRELATION_MISMATCH");
    verifyMac(client.proof, key, context, "client", null);
    await send(socket, { kind: "ready", id, proof: mac(key, context, "ready", null) });
    const frame = record(await receive(socket, deadline, reserve), ["kind", "id", "request", "proof"]);
    if (frame.kind !== "request" || correlation(frame.id) !== id) throw failure("CORRELATION_MISMATCH");
    verifyMac(frame.proof, key, context, "request", frame.request);
    const request = validateRequest(frame.request), result = deferred<Outcome>();
    enqueue(epoch, { request, execute: async operation => {
      await send(socket, { kind: "started", id, proof: mac(key, context, "started", null) });
      return await epoch.execute(operation);
    }, deadline, alive: () => !socket.destroyed, local: false, finish: result.resolve });
    const outcome = await result.promise;
    if (socket.destroyed) throw failure("RESPONSE_UNDELIVERED", outcome.ok ? undefined : outcome.error,
      { commitStatus: request.kind === "read" ? "not-applicable" : "unknown" });
    if (outcome.ok) await send(socket, { kind: "result", id, value: outcome.value, proof: mac(key, context, "result", outcome.value) });
    else {
      const error = encodeError(outcome.error);
      await send(socket, { kind: "error", id, error, proof: mac(key, context, "error", error) });
    }
  } catch (cause) {
    const error = failure("REQUEST_FAILED", cause, { coordinationRequestId: id });
    if (epoch.state === "closed") {
      socket.destroy();
    } else if (!socket.destroyed) {
      try { await send(socket, { kind: "error", ...(id ? { id } : {}), error: encodeError(cause) }); }
      catch (delivery) { logFailure(epoch, failure("RESPONSE_UNDELIVERED", new AggregateError([error, delivery])), id); }
    } else if (admitted) logFailure(epoch, error, id);
  } finally { epoch.buffered -= charged; }
}

/** Return retry only before business bytes are sent; a lost write response is never replayed. */
async function remoteRequest(pipe: string, root: ShellUpdateFileRoot, request: ShellUpdateFileRequest, deadline: number,
  beforeSend?: () => Promise<void>): Promise<unknown> {
  const socket = new net.Socket(), id = crypto.randomUUID();
  let sent = false, authoritative = false;
  socket.on("error", () => { /* The awaited connect/receive/send rejects with the same socket error. */ });
  try {
    await connect(socket, pipe, deadline);
    const clientNonce = crypto.randomBytes(32).toString("hex");
    await send(socket, { kind: "hello", protocol: PROTOCOL, contract: CONTRACT, id, root, nonce: clientNonce });
    const challenge = record(await receive(socket, deadline), undefined);
    if (challenge.kind === "busy" && challenge.id === id) return undefined;
    if (challenge.kind === "error") throw decodeError(challenge.error);
    exact(challenge, ["kind", "id", "epoch", "nonce", "proof"]);
    if (challenge.kind !== "challenge" || challenge.id !== id) throw failure("CORRELATION_MISMATCH");
    const key = await authenticationKey(root, false), context = authContext(root, correlation(challenge.epoch), id, clientNonce, nonce(challenge.nonce));
    verifyMac(challenge.proof, key, context, "server", null);
    await send(socket, { kind: "proof", id, proof: mac(key, context, "client", null) });
    const ready = record(await receive(socket, deadline), ["kind", "id", "proof"]);
    if (ready.kind !== "ready" || ready.id !== id) throw failure("CORRELATION_MISMATCH");
    verifyMac(ready.proof, key, context, "ready", null);
    await beforeSend?.();
    sent = true;
    await send(socket, { kind: "request", id, request, proof: mac(key, context, "request", request) });
    let response = record(await receive(socket, deadline, undefined, true), undefined);
    if (response.kind === "started") {
      exact(response, ["kind", "id", "proof"]);
      if (response.id !== id) throw failure("CORRELATION_MISMATCH");
      verifyMac(response.proof, key, context, "started", null);
      response = record(await receive(socket, Infinity, undefined, true), undefined);
    }
    if (response.id !== id) throw failure("CORRELATION_MISMATCH");
    if (response.kind === "error") {
      exact(response, ["kind", "id", "error", "proof"]); verifyMac(response.proof, key, context, "error", response.error);
      const error = decodeError(response.error); authoritative = true; throw error;
    }
    exact(response, ["kind", "id", "value", "proof"]);
    if (response.kind !== "result") throw failure("PROTOCOL_MISMATCH");
    verifyMac(response.proof, key, context, "result", response.value);
    return response.value;
  } catch (cause) {
    if (!sent && nativeCode(cause, ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "DESKTOP_SHELL_UPDATE_COORDINATOR_CONNECTION_CLOSED"])) return undefined;
    if (sent && !authoritative && request.kind !== "read") throw failure("COMMIT_UNKNOWN", cause, { commitStatus: "unknown", coordinationRequestId: id });
    throw cause;
  } finally { socket.destroy(); }
}

/** Bound connect separately; started physical operations are never raced against this timer. */
async function connect(socket: Socket, pipe: string, deadline: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = Number.isFinite(deadline) ? setTimeout(() => finish(failure("DEADLINE_EXCEEDED")), Math.max(1, deadline - Date.now())) : undefined;
    const onError = (cause: Error) => finish(cause);
    const onConnect = () => finish();
    /** Release listeners for this one connect attempt. */
    function finish(cause?: unknown) {
      clearTimeout(timer); socket.removeListener("error", onError); socket.removeListener("connect", onConnect);
      cause === undefined ? resolve() : reject(cause);
    }
    socket.once("error", onError); socket.once("connect", onConnect); socket.connect(pipe);
  });
}

/** A fixed length prefix rejects oversized, truncated, extra and non UTF-8 frames. */
async function receive(socket: Socket, deadline: number, reserve: (bytes: number) => void = () => {}, remainder = false): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), length: number | undefined, done = false;
    const timer = Number.isFinite(deadline) ? setTimeout(() => finish(failure("DEADLINE_EXCEEDED")), Math.max(1, deadline - Date.now())) : undefined;
    const onError = (cause: Error) => finish(cause);
    const onClose = () => finish(failure("CONNECTION_CLOSED"));
    const onData = (chunk: Buffer) => {
      try {
        if (!remainder && buffer.length + chunk.length > MAX_FRAME + 4) throw failure("FRAME_INVALID");
        buffer = Buffer.concat([buffer, chunk]);
        if (length === undefined && buffer.length >= 4) {
          length = buffer.readUInt32BE();
          if (!length || length > MAX_FRAME) throw failure("FRAME_INVALID");
          reserve(length);
        }
        if (length !== undefined && buffer.length >= length + 4) {
          if (!remainder && buffer.length !== length + 4) throw failure("FRAME_INVALID");
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, length + 4)));
          if (buffer.length > length + 4) socket.unshift(buffer.subarray(length + 4));
          finish(undefined, value);
        }
      } catch (cause) { finish(cause); }
    };
    /** A settled frame cannot retain data or error listeners. */
    function finish(cause?: unknown, value?: unknown) {
      if (done) return; done = true;
      socket.pause();
      clearTimeout(timer); socket.removeListener("data", onData); socket.removeListener("error", onError); socket.removeListener("close", onClose);
      cause === undefined ? resolve(value) : reject(cause);
    }
    socket.on("data", onData); socket.once("error", onError); socket.once("close", onClose);
    if (socket.destroyed) finish(failure("CONNECTION_CLOSED"));
    else socket.resume();
  });
}

/** Flush one bounded response without leaving an unobserved rejection. */
async function send(socket: Socket, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (!body.length || body.length > MAX_FRAME) throw failure("FRAME_INVALID");
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { finish(failure("DEADLINE_EXCEEDED")); socket.destroy(); }, BUDGET);
    const onError = (cause: Error) => finish(cause);
    const onClose = () => finish(failure("CONNECTION_CLOSED"));
    /** A stalled peer cannot retain an epoch after physical work has finished. */
    function finish(cause?: unknown) {
      if (done) return; done = true; clearTimeout(timer);
      socket.removeListener("error", onError); socket.removeListener("close", onClose);
      cause === undefined ? resolve() : reject(cause);
    }
    socket.once("error", onError); socket.once("close", onClose);
    socket.write(Buffer.concat([prefix, body]), error => finish(error ?? undefined));
  });
}

/** Only known physical shapes enter the queue; business validation remains in the store. */
function validateRequest(input: unknown): ShellUpdateFileRequest {
  const value = record(input, undefined);
  if (value.kind === "read") exact(value, ["kind"]);
  else if (value.kind === "checkExpected") exact(value, ["kind", "expected"]);
  else if (value.kind === "replace") exact(value, ["kind", "expected", "next"]);
  else throw failure("REQUEST_INVALID");
  return value as ShellUpdateFileRequest;
}

/** Reject inherited properties, accessors and custom prototypes before transport. */
function record(input: unknown, keys: string[] | undefined): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw failure("FRAME_INVALID");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !descriptor || !Object.hasOwn(descriptor, "value")) throw failure("FRAME_INVALID");
    result[key] = descriptor.value;
  }
  if (keys) exact(result, keys);
  return result;
}

/** An exact shape cannot smuggle protocol options through unknown keys. */
function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw failure("FRAME_INVALID");
}

/** Root identities remain lossless strings on the wire. */
function readRoot(input: unknown): ShellUpdateFileRoot {
  const value = record(input, ["root", "dev", "ino"]); pipeName(value as ShellUpdateFileRoot);
  return value as ShellUpdateFileRoot;
}

/** Aliases share an election key but may not impersonate a different bound root. */
function sameRoot(left: ShellUpdateFileRoot, right: ShellUpdateFileRoot): boolean {
  return left.root === right.root && left.dev === right.dev && left.ino === right.ino;
}

/** Correlation identifiers are generated locally, not business permission tokens. */
function correlation(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9-]{36}$/u.test(input)) throw failure("CORRELATION_MISMATCH");
  return input;
}

/** Only structural OS codes qualify a pre-send election retry. */
function nativeCode(cause: unknown, codes: string[]): boolean {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string" && codes.includes(cause.code);
}

/**
 * 探针文件被安全软件/索引器短暂占用时重试：每轮先复核目录与实体，预算内只重试锁类错误，
 * 其他故障立即抛出；耗尽时保留首因并追加复核失败。
 */
export async function retryTransientRename(operation: () => Promise<void>, beforeAttempt: () => Promise<void>,
  options: { budgetMs?: number; pollMs?: number; isTransient?: (cause: unknown) => boolean } = {}): Promise<void> {
  const budgetMs = options.budgetMs ?? 1000, pollMs = options.pollMs ?? 10;
  const started = performance.now();
  let first: unknown;
  for (;;) {
    try { await beforeAttempt(); }
    catch (cause) { throw first ? new AggregateError([first, cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_RENAME_RECHECK_FAILED") : cause; }
    try { await operation(); return; }
    catch (cause) {
      if (!(options.isTransient?.(cause) ?? false)) {
        throw first ? new AggregateError([first, cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_RENAME_RETRY_FAILED") : cause;
      }
      first ??= cause;
    }
    const remaining = budgetMs - (performance.now() - started);
    if (remaining <= 0) throw first;
    await delay(Math.min(pollMs, remaining));
  }
}

/** Reuse an immutable key only while the same ordinary root, directory and file remain bound. */
async function authenticationKey(root: ShellUpdateFileRoot, initialize: boolean): Promise<Buffer> {
  const owner = pipeName(root), directory = path.join(root.root, AUTH_DIRECTORY), target = path.join(directory, "key");
  await assertAuthRoot(root);
  let directoryStat: BigIntStats, published = false;
  try { directoryStat = await fs.lstat(directory, { bigint: true }); }
  catch (cause) {
    if (!(initialize && nativeCode(cause, ["ENOENT"]))) throw failure("AUTH_KEY_INVALID", cause);
    await publishAuthenticationKey(root, directory);
    published = true;
    directoryStat = await fs.lstat(directory, { bigint: true });
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure("AUTH_KEY_INVALID");
  const names = await fs.readdir(directory);
  if (names.length !== 1 || names[0] !== "key") throw failure("AUTH_KEY_INVALID");
  let before = await fs.lstat(target, { bigint: true });
  if (!ordinaryKey(before)) throw failure("AUTH_KEY_INVALID");
  const cached = authKeys.get(owner);
  if (cached) {
    if (cached.directory.dev !== directoryStat.dev || cached.directory.ino !== directoryStat.ino
      || cached.file.dev !== before.dev || cached.file.ino !== before.ino) throw failure("AUTH_KEY_INVALID");
    if (sameStat(cached.directory, directoryStat) && sameStat(cached.file, before)) { await assertAuthRoot(root); return cached.key; }
  }
  if (!published) {
    await authenticationPermissions(directory, "verify");
    directoryStat = await fs.lstat(directory, { bigint: true });
    before = await fs.lstat(target, { bigint: true });
    if (!ordinaryKey(before)) throw failure("AUTH_KEY_INVALID");
  }
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let key: Buffer | undefined, primary: { cause: unknown } | undefined;
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameStat(opened, before)) throw failure("AUTH_KEY_INVALID");
    key = await readKey(file);
    if (!sameStat(opened, await file.stat({ bigint: true })) || !sameStat(opened, await fs.lstat(target, { bigint: true }))) throw failure("AUTH_KEY_INVALID");
  } catch (cause) { primary = { cause }; }
  try { await file.close(); }
  catch (cause) { throw Object.assign(new AggregateError([...(primary ? [primary.cause] : []), cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_CLOSE_FAILED"), { resourcesReleased: false }); }
  if (primary) throw primary.cause;
  if (!key || !sameStat(directoryStat, await fs.lstat(directory, { bigint: true }))) throw failure("AUTH_KEY_INVALID");
  if (cached && !key.equals(cached.key)) throw failure("AUTH_KEY_INVALID");
  await assertAuthRoot(root);
  authKeys.set(owner, { key, directory: directoryStat, file: before });
  return key;
}

/** Only the pipe winner publishes a complete nonempty directory; failed staging remains evidence. */
async function publishAuthenticationKey(root: ShellUpdateFileRoot, destination: string): Promise<void> {
  const staging = path.join(root.root, `${AUTH_DIRECTORY}-init-${crypto.randomUUID()}`), key = crypto.randomBytes(32);
  await authenticationPermissions(staging, "create");
  const stagingStat = await fs.lstat(staging, { bigint: true });
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) throw failure("AUTH_KEY_INVALID");
  const file = await fs.open(path.join(staging, "key"), "wx+", 0o600);
  let primary: { cause: unknown } | undefined;
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) throw failure("AUTH_KEY_INVALID");
    let offset = 0;
    while (offset < key.length) {
      const { bytesWritten } = await file.write(key, offset, key.length - offset, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > key.length - offset) throw failure("AUTH_KEY_INVALID");
      offset += bytesWritten;
    }
    await file.sync();
    const written = await file.stat({ bigint: true });
    if (!ordinaryKey(written) || written.dev !== opened.dev || written.ino !== opened.ino || !(await readKey(file)).equals(key)
      || !sameStat(written, await file.stat({ bigint: true })) || !sameStat(written, await fs.lstat(path.join(staging, "key"), { bigint: true }))) throw failure("AUTH_KEY_INVALID");
  } catch (cause) { primary = { cause }; }
  try { await file.close(); }
  catch (cause) { throw Object.assign(new AggregateError([...(primary ? [primary.cause] : []), cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_CLOSE_FAILED"), { resourcesReleased: false }); }
  if (primary) throw primary.cause;
  await assertAuthRoot(root);
  if ((await fs.lstat(staging, { bigint: true })).ino !== stagingStat.ino) throw failure("AUTH_KEY_INVALID");
  await authenticationPermissions(staging, "seal");
  try { await fs.lstat(destination, { bigint: true }); }
  catch (cause) {
    if (!nativeCode(cause, ["ENOENT"])) throw cause;
    await fs.rename(staging, destination); return;
  }
  throw failure("AUTH_KEY_ALREADY_EXISTS");
}

/** Create private ACLs before key creation; existing material must already belong only to the OS token. */
async function authenticationPermissions(directory: string, mode: "create" | "seal" | "verify"): Promise<void> {
  const encoded = Buffer.from(directory, "utf8").toString("base64");
  const script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
    + "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'));"
    + "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$full=[Security.AccessControl.FileSystemRights]::FullControl;"
    + (mode === "create" ? "if([IO.Directory]::Exists($p)){throw 'AUTH_DIRECTORY_EXISTS'};"
      + "$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);"
      + "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$full,'ContainerInherit,ObjectInherit','None','Allow'));"
      + "[IO.DirectoryInfo]::new($p).Create($acl);" : "")
    + "$paths=@($p);" + (mode !== "create" ? "$paths+=([IO.Path]::Combine($p,'key'));" : "")
    + "foreach($item in $paths){$isDirectory=($item -eq $p);"
    + "$acl=if($isDirectory){[IO.Directory]::GetAccessControl($item)}else{[IO.File]::GetAccessControl($item)};"
    + "$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));"
    + "if($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or $rules.Count -ne 1"
    + " -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne $full){throw 'AUTH_ACL_INVALID'};"
    + (mode === "seal" ? "if(-not $isDirectory){$acl.SetAccessRuleProtection($true,$false);"
      + "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$full,'Allow'));[IO.File]::SetAccessControl($item,$acl);"
      + "$acl=[IO.File]::GetAccessControl($item);};" : "")
    + "if(-not $acl.AreAccessRulesProtected){throw 'AUTH_ACL_NOT_PROTECTED'};};";
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  try {
    await execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch (cause) { throw failure("AUTH_PERMISSION_UNAVAILABLE", cause, { phase: "auth-permission", path: directory }); }
}

/** Prove the same-account root can create, sync, replace and read a file before exposing the pipe. */
async function capabilityPreflight(root: ShellUpdateFileRoot): Promise<void> {
  let phase = "root";
  const directory = path.join(root.root, `${CAPABILITY_DIRECTORY_PREFIX}${crypto.randomUUID()}`);
  const source = path.join(directory, "source"), target = path.join(directory, "target");
  const replacement = Buffer.from(`codeflowai-shell-update-capability:${crypto.randomUUID()}`, "utf8");
  let directoryCreated = false, directoryIdentity: BigIntStats | undefined;
  let sourceIdentity: BigIntStats | undefined, targetIdentity: BigIntStats | undefined;
  let primary: { cause: unknown; phase: string } | undefined, cleanup: { cause: unknown } | undefined;
  try {
    await assertAuthRoot(root);
    phase = "existing-attempt";
    await assertExistingAttemptWritable(root);
    await assertAuthRoot(root);
    phase = "create-directory";
    await mkdirNative(directory, { mode: 0o700 });
    directoryCreated = true;
    directoryIdentity = await lstatNative(directory, { bigint: true });
    await assertCapabilityDirectory(root, directory, directoryIdentity);
    phase = "write-source";
    sourceIdentity = await writeCapabilityFile(source, replacement);
    phase = "write-target";
    targetIdentity = await writeCapabilityFile(target, Buffer.from("target", "utf8"));
    phase = "replace";
    /** 每轮重核目录与探针实体；仅 Windows rename 的锁类错误可重试。 */
    await retryTransientRename(
      () => renameNative(source, target),
      async () => {
        await assertCapabilityDirectory(root, directory, directoryIdentity);
        if (!sourceIdentity || !sameProbeIdentity(sourceIdentity, await lstatNative(source, { bigint: true }))
          || !targetIdentity || !sameProbeIdentity(targetIdentity, await lstatNative(target, { bigint: true }))) {
          throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
        }
      },
      { isTransient: cause => process.platform === "win32" && nativeCode(cause, ["EPERM", "EACCES", "EBUSY"])
        && cause instanceof Error && "syscall" in cause && cause.syscall === "rename"
        && "path" in cause && cause.path === source && "dest" in cause && cause.dest === target },
    );
    targetIdentity = sourceIdentity;
    sourceIdentity = undefined;
    phase = "readback";
    await readCapabilityFile(target, targetIdentity, replacement);
    await assertCapabilityDirectory(root, directory, directoryIdentity);
  } catch (cause) { primary = { cause, phase }; }
  if (directoryCreated) {
    try { await cleanupCapability(root, directory, directoryIdentity, source, target, sourceIdentity, targetIdentity); }
    catch (cause) { cleanup = { cause }; }
  }
  if (!cleanup && nativeCode(primary?.cause, ["DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_MISMATCH"])) throw primary!.cause;
  if (cleanup) {
    const causes = [...(primary ? [primary.cause] : []), cleanup.cause];
    throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE", new AggregateError(causes, "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_CLEANUP_FAILED"),
      { phase: "cleanup", resourcesReleased: false });
  }
  if (primary) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE", primary.cause, { phase: primary.phase });
}

/** Existing attempt files must be writable by the same account before a pipe becomes ready. */
async function assertExistingAttemptWritable(root: ShellUpdateFileRoot): Promise<void> {
  const target = path.join(root.root, ATTEMPT_FILENAME);
  let before: BigIntStats;
  try {
    before = await fs.lstat(target, { bigint: true });
  } catch (cause) {
    if (nativeCode(cause, ["ENOENT"])) return;
    throw cause;
  }
  if (!ordinaryKeyLike(before)) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  const file = await openNative(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: { cause: unknown } | undefined;
  try {
    if (!sameStat(before, await file.stat({ bigint: true })) || !sameStat(before, await fs.lstat(target, { bigint: true }))) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  } catch (cause) { primary = { cause }; }
  try { await file.close(); }
  catch (cause) { throw Object.assign(new AggregateError([...(primary ? [primary.cause] : []), cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_CLOSE_FAILED"), { resourcesReleased: false }); }
  if (primary) throw primary.cause;
}

/** Write a probe file with the same close and content checks as the real attempt. */
async function writeCapabilityFile(target: string, bytes: Buffer): Promise<BigIntStats> {
  const file = await openNative(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let primary: { cause: unknown } | undefined, written: BigIntStats | undefined;
  try {
    const opened = await file.stat({ bigint: true });
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
      offset += bytesWritten;
    }
    await file.sync();
    written = await file.stat({ bigint: true });
    if (!ordinaryKeyLike(written) || written.size !== BigInt(bytes.byteLength)
      || !(await readCapabilityBytes(file, bytes.byteLength)).equals(bytes)
      || !sameStat(written, await file.stat({ bigint: true })) || !sameStat(written, await lstatNative(target, { bigint: true }))) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
    if (opened.dev !== written.dev || opened.ino !== written.ino) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  } catch (cause) { primary = { cause }; }
  try { await file.close(); }
  catch (cause) {
    throw Object.assign(new AggregateError([...(primary ? [primary.cause] : []), cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_CLOSE_FAILED"),
      { resourcesReleased: false });
  }
  if (primary) throw primary.cause;
  const final = await lstatNative(target, { bigint: true });
  if (!written || !sameProbeIdentity(written, final)) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  return final;
}

/** Probe readback requires exact stable bytes and keeps ownership until its handle closes. */
async function readCapabilityFile(target: string, expected: BigIntStats, bytes: Buffer): Promise<void> {
  const file = await openNative(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: { cause: unknown } | undefined;
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameProbeIdentity(expected, opened) || opened.size !== BigInt(bytes.length)
      || !(await readCapabilityBytes(file, bytes.length)).equals(bytes)
      || !sameStat(opened, await file.stat({ bigint: true }))
      || !sameStat(opened, await lstatNative(target, { bigint: true }))) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  } catch (cause) { primary = { cause }; }
  try { await file.close(); }
  catch (cause) { throw Object.assign(new AggregateError([...(primary ? [primary.cause] : []), cause], "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_CLOSE_FAILED"), { resourcesReleased: false }); }
  if (primary) throw primary.cause;
}

/** Read a bounded probe payload from its already-owned handle. */
async function readCapabilityBytes(file: fs.FileHandle, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(bytes, offset, length - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length - offset) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== length) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  return bytes;
}

/** Remove only this run's uniquely named probe and surface unknown cleanup. */
async function cleanupCapability(root: ShellUpdateFileRoot, directory: string, directoryIdentity: BigIntStats | undefined,
  source: string, target: string, sourceIdentity?: BigIntStats, targetIdentity?: BigIntStats): Promise<void> {
  await assertCapabilityDirectory(root, directory, directoryIdentity);
  for (const [file, expected] of [[source, sourceIdentity], [target, targetIdentity]] as const) {
    try {
      const actual = await lstatNative(file, { bigint: true });
      if (!expected || !sameProbeIdentity(expected, actual)) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
      await assertCapabilityDirectory(root, directory, directoryIdentity);
      await unlinkNative(file);
    } catch (cause) { if (!nativeCode(cause, ["ENOENT"])) throw cause; }
  }
  await assertCapabilityDirectory(root, directory, directoryIdentity);
  await rmdirNative(directory);
}

/** A probe path may be used or removed only while its original root and directory remain bound. */
async function assertCapabilityDirectory(root: ShellUpdateFileRoot, directory: string, expected: BigIntStats | undefined): Promise<void> {
  await assertAuthRoot(root);
  const actual = await lstatNative(directory, { bigint: true });
  if (!expected || !actual.isDirectory() || actual.isSymbolicLink() || expected.dev !== actual.dev || expected.ino !== actual.ino) throw failure("CAPABILITY_WRITE_RENAME_UNAVAILABLE");
}

/** A bounded explicit-offset read cannot accept truncated or oversized key files. */
async function readKey(file: fs.FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(33); let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) throw failure("AUTH_KEY_INVALID");
    if (!bytesRead) break; offset += bytesRead;
  }
  if (offset !== 32) throw failure("AUTH_KEY_INVALID");
  return buffer.subarray(0, 32);
}

/** Authentication file work never follows a replaced or aliased root. */
async function assertAuthRoot(root: ShellUpdateFileRoot): Promise<void> {
  const stat = await fs.lstat(root.root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== root.dev || stat.ino.toString() !== root.ino
    || await fs.realpath(root.root) !== root.root) throw failure("ROOT_MISMATCH");
}

/** Key files must retain their sole ordinary directory entry. */
function ordinaryKey(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === 32n;
}

/** Probe files must remain ordinary single-link files throughout the capability check. */
function ordinaryKeyLike(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
}

/** Probe cleanup may remove only the same ordinary inode created by this epoch. */
function sameProbeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return ordinaryKeyLike(left) && ordinaryKeyLike(right) && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink;
}

/** Metadata binds both file content stability and directory publication identity. */
function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Nonces are fresh per connection and never treated as business authorization. */
function nonce(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw failure("AUTH_FAILED");
  return value;
}

/** A fixed ordered context separates roles, roots, contracts and connections. */
function authContext(root: ShellUpdateFileRoot, epoch: string, id: string, client: string, server: string): string[] {
  return [String(PROTOCOL), CONTRACT, JSON.stringify([root.root, root.dev, root.ino]), epoch, id, client, server];
}

/** Every business frame is bound to the authenticated connection and complete canonical value. */
function mac(key: Buffer, context: string[], direction: string, value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw failure("FRAME_INVALID");
  return crypto.createHmac("sha256", key).update(JSON.stringify(["codeflowai-shell-file", ...context, direction, text])).digest("hex");
}

/** Constant-time comparison never includes a key or proof in diagnostic errors. */
function verifyMac(proof: unknown, key: Buffer, context: string[], direction: string, value: unknown): void {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/u.test(proof)
    || !crypto.timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(mac(key, context, direction, value), "hex"))) throw failure("AUTH_FAILED");
}

/** Resource ownership markers survive wrapper and aggregate causes. */
function unreleased(cause: unknown): boolean {
  return cause instanceof Error && (("resourcesReleased" in cause && cause.resourcesReleased === false)
    || unreleased(cause.cause) || cause instanceof AggregateError && cause.errors.some(unreleased));
}

/** Explicit transport failures carry correlation and never pretend an unknown write did not commit. */
function failure(suffix: string, cause?: unknown, context: Record<string, unknown> = {}): Error {
  const code = `DESKTOP_SHELL_UPDATE_COORDINATOR_${suffix}`;
  return Object.assign(new Error(code, { cause }), { code, ...context });
}

const ERROR_FIELDS = ["code", "phase", "requestId", "stateReplaced", "resourcesReleased", "commitStatus", "coordinationRequestId",
  "errno", "syscall", "path", "dest", "attempts", "elapsedMs"];

/** Preserve scalar, cause and aggregate errors; unsupported causes fail serialization explicitly. */
function encodeError(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (depth > 16 || seen.has(value)) throw failure("ERROR_SERIALIZATION_FAILED");
  if (value === undefined) return { type: "undefined" };
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return { type: "value", value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (!(value instanceof Error)) throw failure("ERROR_SERIALIZATION_FAILED");
  seen.add(value);
  const fields: Record<string, unknown> = {};
  for (const key of ERROR_FIELDS) if (Object.hasOwn(value, key)) fields[key] = encodeError((value as any)[key], seen, depth + 1);
  const result = { type: value instanceof AggregateError ? "aggregate" : "error", name: value.name, message: value.message, fields,
    ...(Object.hasOwn(value, "cause") ? { cause: encodeError(value.cause, seen, depth + 1) } : {}),
    ...(value instanceof AggregateError ? { errors: value.errors.map(item => encodeError(item, seen, depth + 1)) } : {}),
    ...(Object.hasOwn(value, "lastCause") ? { lastCause: encodeError((value as any).lastCause, seen, depth + 1) } : {}) };
  seen.delete(value); return result;
}

/** Rebuild only the bounded error contract, never arbitrary prototypes from the peer. */
function decodeError(input: unknown, depth = 0): unknown {
  if (depth > 16) throw failure("FRAME_INVALID");
  const value = record(input, undefined);
  if (value.type === "undefined") { exact(value, ["type"]); return undefined; }
  if (value.type === "value") { exact(value, ["type", "value"]); if (value.value !== null && !["string", "number", "boolean"].includes(typeof value.value)) throw failure("FRAME_INVALID"); return value.value; }
  if (value.type === "bigint") { exact(value, ["type", "value"]); if (typeof value.value !== "string" || !/^-?[0-9]+$/u.test(value.value)) throw failure("FRAME_INVALID"); return BigInt(value.value); }
  if (!["error", "aggregate"].includes(value.type) || typeof value.name !== "string" || typeof value.message !== "string") throw failure("FRAME_INVALID");
  exact(value, ["type", "name", "message", "fields", ...(Object.hasOwn(value, "cause") ? ["cause"] : []),
    ...(value.type === "aggregate" ? ["errors"] : []), ...(Object.hasOwn(value, "lastCause") ? ["lastCause"] : [])]);
  if (value.type === "aggregate" && (!Array.isArray(value.errors) || value.errors.length > MAX_PENDING)) throw failure("FRAME_INVALID");
  const result = value.type === "aggregate" ? new AggregateError(value.errors.map((item: unknown) => decodeError(item, depth + 1)), value.message) : new Error(value.message);
  result.name = value.name;
  const fields = record(value.fields, undefined);
  for (const key of Object.keys(fields)) {
    if (!ERROR_FIELDS.includes(key)) throw failure("FRAME_INVALID");
    Object.defineProperty(result, key, { value: decodeError(fields[key], depth + 1), enumerable: true, configurable: true, writable: true });
  }
  if (Object.hasOwn(value, "cause")) Object.defineProperty(result, "cause", { value: decodeError(value.cause, depth + 1), configurable: true });
  if (Object.hasOwn(value, "lastCause")) Object.defineProperty(result, "lastCause", { value: decodeError(value.lastCause, depth + 1), enumerable: true });
  return result;
}

/** Only undeliverable request failures belong to the coordinator's logging boundary. */
function logFailure(epoch: Epoch, cause: unknown, requestId?: string): void {
  console.error(JSON.stringify({ code: "DESKTOP_SHELL_UPDATE_COORDINATOR_UNDELIVERED", requestId, root: epoch.root.root,
    rootDev: epoch.root.dev, rootIno: epoch.root.ino, ownerPid: process.pid, ownerScopeId: epoch.owner?.id,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message, code: "code" in cause ? cause.code : undefined } : String(cause) }));
}
