import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertReleaseBundleManifest, assertReleaseId, type ReleaseBundleManifest } from "./contracts.js";
import { verifyReleaseBundlePayload, verifyReleaseBundleSignature,
  type TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { createUpdateFailureJournal, type UpdateFailureContext, type UpdateFailureRecord } from "./updateFailureJournal.js";
import { extractReleaseBundle } from "./releaseBundleExtract.js";
import { createDesktopUpdateReceipt, type DesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import type { DesktopBundleUpdatePhase, DesktopUpdateResult, DesktopBundleVersion } from "@codeflowai/shared";
import { writeDurableJson, flushDirectory } from "./durableFile.js";

export { computeReleasePackageSha256 } from "@codeflowai/shared/desktop-release-signing";

type ReleaseTrustOptions = { trustedReleaseKeys?: TrustedReleaseKeys; platform?: string; arch?: string; now?: () => number; requireHeldStartup?: boolean };
type InstalledReleaseTrustOptions = ReleaseTrustOptions & { verification?: "full" | "startup" | "installed" };

export type PreparedRelease = {
  requestId: string;
  manifest: ReleaseBundleManifest;
  stagingDir: string;
};

export type ActiveRelease = {
  releaseId: string;
  releaseDir: string;
  previousReleaseId: string | null;
  manifest: ReleaseBundleManifest;
};

export type ReleaseSwitchHooks = {
  checkCompatibility(manifest: ReleaseBundleManifest): Promise<void>;
  drain(): Promise<void>;
  restartClient(releaseDir: string, manifest: ReleaseBundleManifest): Promise<void>;
  reloadWeb(releaseDir: string, manifest: ReleaseBundleManifest): Promise<void>;
  waitHealthy(releaseDir: string): Promise<boolean>;
  restoreInitialRelease(): Promise<void>;
  /** 完整安装基线接管期间，候选回退必须恢复已验签的新基线而非旧活动包。 */
  restoreInitialOnFailure?: boolean;
  /** 候选停止并恢复数据库后，才允许重新启动旧资源。 */
  beforeRestore?(): Promise<void>;
};

/** 用户选择稍后是正常中止切换，不写失败日志或失败回执。 */
export class DesktopUpdatePostponed extends Error {
  /** 供壳识别正常推迟，不把用户选择映射为失败。 */
  constructor() { super("DESKTOP_UPDATE_POSTPONED"); }
}

type ReleaseBundleCoordinator = {
  prepare(packageDir: string, options?: { signal?: AbortSignal; requestId?: string }): Promise<PreparedRelease>;
  resume(pending: { requestId: string; releaseId: string; stagingDir: string },
    installed?: Pick<ReleaseBundleManifest, "releaseId" | "archiveSha256">): Promise<PreparedRelease>;
  switch(prepared: PreparedRelease, hooks: ReleaseSwitchHooks): Promise<ActiveRelease>;
};

/** following 是已观察到的下一阶段事实，持久 reporter 必须先一并落盘再联网。 */
type ReleaseReceiptReporter = (receipt: DesktopUpdateReceipt, following?: DesktopUpdateReceipt) => Promise<void>;
export type ReleaseBundleDiagnostic = { requestId: string; releaseId?: string; phase: string; outcome: "start" | "success" | "failure";
  durationMs?: number; errorCode?: string; receivedBytes?: number; totalBytes?: number };

const ACTIVE_POINTER = "active-release.json";
const PREVIOUS_POINTER = "previous-release.json";

/** 创建绑定发布包协调器；包目录是 Server 完整包下载后的不可变本地副本。 */
export function createReleaseBundleCoordinator(input: ReleaseTrustOptions & { rootDir: string; getFailureContext(): UpdateFailureContext;
  reportReceipt?: ReleaseReceiptReporter; isCancellation?: (error: unknown) => boolean;
  onDiagnostic?: (event: ReleaseBundleDiagnostic) => void;
  onProgress?: (observation: { requestId: string; phase: DesktopBundleUpdatePhase; result?: DesktopUpdateResult; target?: DesktopBundleVersion }) => void }): ReleaseBundleCoordinator {
  const rootDir = path.resolve(input.rootDir);
  const journal = createUpdateFailureJournal(rootDir);
  /** 更新边界记录唯一脱敏待报证据；日志失败也必须保留原始更新错误。 */
  const recordFailure = (context: { requestId: string; releaseId: string; phase: string; error: unknown; recovery: "not_needed" | "restored" | "failed"; rollbackError?: Error | null }): UpdateFailureRecord => {
    return journal.record({ ...input.getFailureContext(), ...context });
  };

  return {
    /** 重新验签、检查入口及 held 证明；同包安装只收口旧记录，其余候选仍须未过期。 */
    async resume(pending, installed): Promise<PreparedRelease> {
      const directory = path.resolve(pending.stagingDir);
      if (path.dirname(directory) !== path.join(rootDir, ".staging")
        && directory !== path.join(rootDir, "releases", assertReleaseId(pending.releaseId))) throw new Error("DESKTOP_RELEASE_STAGING_INVALID");
      const installedIdMatches = installed?.releaseId === pending.releaseId;
      const manifest = await verifyReleaseBundle(directory, { ...input, requireHeldStartup: true }, !installedIdMatches);
      if (manifest.releaseId !== pending.releaseId) throw new Error("DESKTOP_PENDING_RELEASE_INVALID");
      if (installedIdMatches && manifest.archiveSha256 !== installed!.archiveSha256) {
        throw Object.assign(new Error("DESKTOP_RELEASE_CACHE_CONFLICT"), { code: "DESKTOP_RELEASE_CACHE_CONFLICT", requestId: pending.requestId });
      }
      return { requestId: pending.requestId, stagingDir: directory, manifest };
    },
    /** 准备整组包，切换前仍按相同口径重新校验。 */
    async prepare(packageDir: string, options: { signal?: AbortSignal; requestId?: string } = {}): Promise<PreparedRelease> {
      const requestId = options.requestId ?? crypto.randomUUID();
      let releaseId = "unknown";
      let stagingDir: string | undefined;
      let prepareStartedAt = performance.now();
      try {
        input.onDiagnostic?.({ requestId, phase: "prepare", outcome: "start" });
        input.onProgress?.({ requestId, phase: "prepare" });
        options.signal?.throwIfAborted();
        const sourceDir = path.resolve(packageDir);
        const entries = await fs.readdir(sourceDir);
        const archived = entries.length === 2 && entries.includes("manifest.json") && entries.includes("bundle.tar.gz");
        let verifyStartedAt = performance.now(), manifest: ReleaseBundleManifest;
        input.onDiagnostic?.({ requestId, phase: "verify-source", outcome: "start" });
        try {
          manifest = archived
            ? await verifyManifest(sourceDir, input, true, value => { releaseId = value.releaseId; })
            : await verifyReleaseBundle(sourceDir, input, true, value => { releaseId = value.releaseId; });
        } catch (error) {
          input.onDiagnostic?.({ requestId, releaseId, phase: "verify-source", outcome: "failure",
            durationMs: diagnosticDuration(verifyStartedAt), errorCode: diagnosticErrorCode(error) });
          throw error;
        }
        input.onDiagnostic?.({ requestId, releaseId, phase: "verify-source", outcome: "success", durationMs: diagnosticDuration(verifyStartedAt) });
        input.onProgress?.({ requestId, phase: "prepare", target: versionOf(manifest) });

        const stagingRoot = path.join(rootDir, ".staging");
        await fs.mkdir(stagingRoot, { recursive: true });
        if (!(await fs.lstat(stagingRoot)).isDirectory()) throw new Error("DESKTOP_RELEASE_STAGING_INVALID");
        stagingDir = await fs.mkdtemp(path.join(stagingRoot, `${manifest.releaseId}-`));
        await fs.copyFile(path.join(sourceDir, "manifest.json"), path.join(stagingDir, "manifest.json"));
        const materializeStage = archived ? "extract" : "copy-resources", materializeStartedAt = performance.now();
        input.onDiagnostic?.({ requestId, releaseId, phase: materializeStage, outcome: "start" });
        try {
          if (archived) await extractReleaseBundle({ archivePath: path.join(sourceDir, "bundle.tar.gz"), stagingDir, manifest, signal: options.signal });
          else for (const root of ["web", "client"]) await fs.cp(path.join(sourceDir, root), path.join(stagingDir, root), { recursive: true, errorOnExist: true, force: false });
        } catch (error) {
          input.onDiagnostic?.({ requestId, releaseId, phase: materializeStage, outcome: "failure",
            durationMs: diagnosticDuration(materializeStartedAt), errorCode: diagnosticErrorCode(error) });
          throw error;
        }
        input.onDiagnostic?.({ requestId, releaseId, phase: materializeStage, outcome: "success", durationMs: diagnosticDuration(materializeStartedAt) });
        verifyStartedAt = performance.now(); input.onDiagnostic?.({ requestId, releaseId, phase: "verify-staged", outcome: "start" });
        let staged: ReleaseBundleManifest;
        try { staged = await verifyReleaseBundle(stagingDir, input, true); }
        catch (error) {
          input.onDiagnostic?.({ requestId, releaseId, phase: "verify-staged", outcome: "failure",
            durationMs: diagnosticDuration(verifyStartedAt), errorCode: diagnosticErrorCode(error) });
          throw error;
        }
        input.onDiagnostic?.({ requestId, releaseId, phase: "verify-staged", outcome: "success", durationMs: diagnosticDuration(verifyStartedAt) });
        if (JSON.stringify(staged) !== JSON.stringify(manifest)) throw new Error("准备期间绑定包清单已变更");
        options.signal?.throwIfAborted();
        if (input.reportReceipt) {
          await input.reportReceipt(createReceipt(input.getFailureContext(), requestId, manifest, "verified"));
          await input.reportReceipt(createReceipt(input.getFailureContext(), requestId, manifest, "prepared"));
        }
        input.onDiagnostic?.({ requestId, releaseId: manifest.releaseId, phase: "prepare", outcome: "success",
          durationMs: diagnosticDuration(prepareStartedAt) });
        return { requestId, manifest, stagingDir };
      } catch (error) {
        try { input.onDiagnostic?.({ requestId, releaseId, phase: "prepare", outcome: "failure",
          durationMs: diagnosticDuration(prepareStartedAt), errorCode: diagnosticErrorCode(error) }); }
        catch (diagnosticError) { error = new AggregateError([error, diagnosticError], "DESKTOP_RELEASE_DIAGNOSTIC_FAILED"); }
        let failure = error;
        if (stagingDir) {
          try {
            if (path.dirname(stagingDir) !== path.join(rootDir, ".staging")) throw new Error("DESKTOP_RELEASE_STAGING_INVALID");
            await fs.rm(stagingDir, { recursive: true });
          } catch (cleanup) { failure = new AggregateError([error, cleanup], "DESKTOP_RELEASE_PREPARE_CLEANUP_FAILED"); }
        }
        if (!(failure instanceof AggregateError) && input.isCancellation?.(failure)) throw failure;
        try {
          recordFailure({ requestId, releaseId, phase: "prepare", error: failure, recovery: "not_needed" });
        } catch (logError) {
          throw new AggregateError([failure, logError], "绑定包处理失败且错误日志写入失败");
        }
        throw failure;
      }
    },

    /** 复用已校验的同版目录，只有健康确认后才发布活动指针。 */
    async switch(prepared: PreparedRelease, hooks: ReleaseSwitchHooks): Promise<ActiveRelease> {
      let previousReleaseId: string | null = null;
      const releaseId = prepared.manifest.releaseId;
      const targetDir = path.join(rootDir, "releases", releaseId);
      let phase = "";
      let phaseStartedAt = performance.now();
      let needsRestore = false;
      let activated: ActiveRelease | undefined;
      let activationReceiptError: unknown;
      /** 与原局部 phase 同步，回调失败继续沿原切换异常边界处理。 */
      const setPhase = (next: DesktopBundleUpdatePhase): void => {
        if (phase) input.onDiagnostic?.({ requestId: prepared.requestId, releaseId, phase, outcome: "success",
          durationMs: diagnosticDuration(phaseStartedAt) });
        phase = next; phaseStartedAt = performance.now();
        input.onDiagnostic?.({ requestId: prepared.requestId, releaseId, phase, outcome: "start" });
        input.onProgress?.({ requestId: prepared.requestId, phase: next });
      };
      try {
        setPhase("read-active");
        previousReleaseId = await readActivePointer(rootDir);
        setPhase("verify");
        const verified = await verifyReleaseBundle(prepared.stagingDir, input, true);
        if (JSON.stringify(verified) !== JSON.stringify(prepared.manifest)) throw new Error("待切换绑定包清单已变更");
        setPhase("compatibility");
        await hooks.checkCompatibility(verified);
        setPhase("prepare-directory");
        if (await pathExists(targetDir)) {
          const existing = await verifyReleaseBundle(targetDir, input);
          if (JSON.stringify(existing) !== JSON.stringify(verified)) throw new Error(`绑定包版本内容冲突：${releaseId}`);
          // 已有完整目标时只删除本次暂存副本，避免稍后重试累积整组包。
          const stagingRoot = path.join(rootDir, ".staging");
          if (path.resolve(prepared.stagingDir) !== targetDir && (path.dirname(path.resolve(prepared.stagingDir)) !== stagingRoot
            || !(await fs.lstat(stagingRoot)).isDirectory())) throw new Error("DESKTOP_RELEASE_STAGING_INVALID");
          if (path.resolve(prepared.stagingDir) !== targetDir) await fs.rm(prepared.stagingDir, { recursive: true });
        } else {
          await fs.mkdir(path.dirname(targetDir), { recursive: true });
          await fs.rename(prepared.stagingDir, targetDir);
        }
        setPhase("drain");
        await hooks.drain();
        needsRestore = true;
        setPhase("restart-client");
        await hooks.restartClient(targetDir, verified);
        setPhase("reload-web");
        await hooks.reloadWeb(targetDir, verified);
        setPhase("health");
        if (!await hooks.waitHealthy(targetDir)) throw new Error("绑定包健康检查失败");
        setPhase("activate");
        if (previousReleaseId) await writePointer(rootDir, PREVIOUS_POINTER, { releaseId: previousReleaseId });
        await writePointer(rootDir, ACTIVE_POINTER, { releaseId });
        activated = { releaseId, releaseDir: targetDir, previousReleaseId, manifest: verified };
        input.onProgress?.({ requestId: prepared.requestId, phase: "activate", result: "healthy", target: versionOf(verified) });
        if (input.reportReceipt) {
          const switched = createReceipt(input.getFailureContext(), prepared.requestId, verified, "switched");
          const healthy = createReceipt(input.getFailureContext(), prepared.requestId, verified, "healthy");
          try { await input.reportReceipt(switched, healthy); }
          catch (reportError) { activationReceiptError = reportError; throw new Error("DESKTOP_RELEASE_RECEIPT_FAILED", { cause: reportError }); }
          try { await input.reportReceipt(healthy); }
          catch (reportError) { activationReceiptError = reportError; throw new Error("DESKTOP_RELEASE_RECEIPT_FAILED", { cause: reportError }); }
        }
        input.onDiagnostic?.({ requestId: prepared.requestId, releaseId, phase, outcome: "success", durationMs: diagnosticDuration(phaseStartedAt) });
        return activated;
      } catch (error) {
        try { input.onDiagnostic?.({ requestId: prepared.requestId, releaseId, phase, outcome: "failure",
          durationMs: diagnosticDuration(phaseStartedAt), errorCode: diagnosticErrorCode(error) }); }
        catch (diagnosticError) { error = new AggregateError([error, diagnosticError], "DESKTOP_RELEASE_DIAGNOSTIC_FAILED"); }
        if (phase === "drain" && !(error instanceof AggregateError)
          && (error instanceof DesktopUpdatePostponed || input.isCancellation?.(error))) throw error;
        let observationFailure: { cause: unknown } | undefined;
        if (needsRestore && !activated) {
          try { input.onProgress?.({ requestId: prepared.requestId, phase: "rollback" }); }
          catch (cause) { observationFailure = { cause }; }
        }
        let rollbackError: Error | null = null;
        let activationUncertain = false;
        if (needsRestore && !activated) {
          const rollbackStartedAt = performance.now();
          try { input.onDiagnostic?.({ requestId: prepared.requestId, releaseId, phase: "rollback", outcome: "start" }); }
          catch (cause) { observationFailure = { cause }; }
          try {
            // rename 后刷盘失败时，先核指针；候选已写入或读回失败均不能破坏配套数据库。
            if (phase === "activate") {
              activationUncertain = true;
              activationUncertain = await readActivePointer(rootDir) === releaseId;
            }
            rollbackError = activationUncertain
              ? new Error("活动指针提交未确认，保留候选与数据库等待启动恢复", { cause: error })
              : await restorePreviousRelease(rootDir, hooks.restoreInitialOnFailure ? null : previousReleaseId, hooks, input);
          } catch (cause) { rollbackError = cause instanceof Error ? cause : new Error(String(cause)); }
          try { input.onDiagnostic?.({ requestId: prepared.requestId, releaseId, phase: "rollback",
            outcome: rollbackError ? "failure" : "success", durationMs: diagnosticDuration(rollbackStartedAt),
            ...(rollbackError ? { errorCode: diagnosticErrorCode(rollbackError) } : {}) }); }
          catch (cause) { observationFailure = { cause: observationFailure ? new AggregateError([observationFailure.cause, cause], "DESKTOP_UPDATE_DIAGNOSTIC_FAILED") : cause }; }
        }
        const localResult = activated ? "healthy" : !needsRestore ? "failure" : rollbackError ? "unavailable" : "restored";
        try { input.onProgress?.({ requestId: prepared.requestId, phase: needsRestore && !activated ? "rollback" : phase as DesktopBundleUpdatePhase, result: localResult }); }
        catch (cause) { observationFailure = { cause: observationFailure ? new AggregateError([observationFailure.cause, cause], "DESKTOP_UPDATE_OBSERVATION_FAILED") : cause }; }
        let receiptError: unknown = activationReceiptError;
        let failureRecord: UpdateFailureRecord;
        try {
          failureRecord = recordFailure({ requestId: prepared.requestId, releaseId, phase, error: receiptError ? new AggregateError([error, receiptError], "DESKTOP_RELEASE_RECEIPT_FAILED") : error, rollbackError,
            recovery: !needsRestore || activated ? "not_needed" : rollbackError ? "failed" : "restored" });
        } catch (logError) {
          throw new AggregateError([error, ...(rollbackError ? [rollbackError] : []), ...(receiptError ? [receiptError] : []),
            ...(observationFailure ? [observationFailure.cause] : []), logError], "绑定包切换失败且错误日志写入失败");
        }
        // 不确定提交不是终局回退；保留原 attempt 供下次启动核验并补齐阶段事实。
        if (input.reportReceipt && needsRestore && !activated && !activationUncertain) {
          const stage = rollbackError ? "unavailable" : "rolled_back";
          try { await input.reportReceipt(createReceipt(input.getFailureContext(), prepared.requestId, prepared.manifest, stage, failureRecord.errorId)); }
          catch (reportError) { receiptError = reportError; }
        }
        if (observationFailure) throw new AggregateError([error, ...(rollbackError ? [rollbackError] : []), ...(receiptError ? [receiptError] : []), observationFailure.cause], "DESKTOP_UPDATE_OBSERVATION_FAILED");
        if (receiptError) throw new AggregateError([error, receiptError], "DESKTOP_RELEASE_RECEIPT_FAILED");
        if (rollbackError) throw new AggregateError([error, rollbackError], "绑定包切换失败且回退失败");
        throw error;
      }
    },
  };
}

/** 原验签清单的安全版本投影；不复制签名、文件清单和路径。 */
function versionOf(manifest: ReleaseBundleManifest): DesktopBundleVersion {
  return { releaseId: manifest.releaseId, version: manifest.version, webVersion: manifest.webVersion, clientVersion: manifest.clientVersion };
}

/** 固定安全错误分类，诊断不序列化异常正文。 */
function diagnosticErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "DESKTOP_RELEASE_FAILED";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(code) ? code : "DESKTOP_RELEASE_FAILED";
}

/** 阶段只使用单调时钟，结果是整数毫秒。 */
function diagnosticDuration(startedAt: number): number { return Math.max(0, Math.round(performance.now() - startedAt)); }

/** 从可信本地上下文构造阶段事实；不存在记者时不联网、不产生回执。 */
function createReceipt(context: UpdateFailureContext, requestId: string, manifest: ReleaseBundleManifest,
  stage: DesktopUpdateReceipt["stage"], errorId?: string): DesktopUpdateReceipt {
  const terminal = stage === "rolled_back" || stage === "unavailable";
  if (terminal && !errorId) throw new Error("DESKTOP_RELEASE_FAILURE_ID_MISSING");
  return createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: context.deviceId, requestId, releaseId: manifest.releaseId,
    archiveSha256: manifest.archiveSha256, stage, at: new Date().toISOString(),
    errorCode: terminal ? "DESKTOP_RELEASE_FAILED" : null,
    errorId: terminal ? errorId! : null });
}

/** 读取活动整组版本指针；损坏文件显式失败。 */
export async function readActivePointer(rootDir: string): Promise<string | null> {
  return readPointer(path.resolve(rootDir), ACTIVE_POINTER);
}

/** 修复基线健康后才移除原不兼容指针；拒绝清除期间出现的其他活动版本。 */
export async function clearIncompatibleActiveRelease(rootDir: string, expectedReleaseId: string | null): Promise<void> {
  const root = path.resolve(rootDir);
  if (await readActivePointer(root) !== expectedReleaseId) throw new Error("DESKTOP_STARTUP_ARTIFACT_CHANGED");
  await fs.rm(path.join(root, ACTIVE_POINTER), { force: true });
  await flushDirectory(root);
}

/** 活动版本默认只验签和检查入口；显式 full 保留完整核验。 */
export async function resolveActiveRelease(rootDir: string, options: InstalledReleaseTrustOptions = {}): Promise<ActiveRelease | null> {
  const resolvedRoot = path.resolve(rootDir);
  const releaseId = await readActivePointer(resolvedRoot);
  if (!releaseId) return null;
  const releaseDir = path.join(resolvedRoot, "releases", releaseId);
  const manifest = await verifyReleaseBundle(releaseDir, options);
  if (manifest.releaseId !== releaseId) throw new Error("活动绑定包版本标识不匹配");
  return { releaseId, releaseDir, previousReleaseId: await readPointer(resolvedRoot, PREVIOUS_POINTER), manifest };
}

/** 固定基线只消费自身签名证明；缺少证明显式报修复安装，不借用其他版本。 */
export async function resolveBaselineRelease(initialReleaseDir: string, options: InstalledReleaseTrustOptions = {}): Promise<{ releaseDir: string; manifest: ReleaseBundleManifest }> {
  const releaseDir = path.resolve(initialReleaseDir), proof = path.join(releaseDir, "baseline-release-manifest.json");
  const root = await fs.lstat(releaseDir);
  let entry;
  try { entry = await fs.lstat(proof); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    throw Object.assign(new Error("DESKTOP_RELEASE_BASELINE_MISSING", { cause }), { code: "DESKTOP_RELEASE_BASELINE_MISSING" });
  }
  if (!root.isDirectory() || root.isSymbolicLink() || !entry.isFile() || entry.isSymbolicLink()) throw new Error("DESKTOP_RELEASE_BASELINE_INVALID");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(proof)));
  return { releaseDir, manifest: await verifyReleaseBundlePayload({ verification: "installed", ...options, directory: releaseDir, manifest,
    trustedKeys: options.trustedReleaseKeys ?? {} }) };
}

async function readPointer(rootDir: string, fileName: string): Promise<string | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(rootDir, fileName), "utf8")) as { releaseId?: unknown };
    return assertReleaseId(value.releaseId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 运行时默认轻量检查；新包仍检查签名期限，保留归档时必须核整包摘要。 */
async function verifyReleaseBundle(directory: string, options: InstalledReleaseTrustOptions, requireFresh = false,
  onManifest?: (manifest: ReleaseBundleManifest) => void): Promise<ReleaseBundleManifest> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!["manifest.json", "bundle.tar.gz", "web", "client"].includes(entry.name) || entry.isSymbolicLink()) throw new Error("DESKTOP_RELEASE_ROOT_INVALID");
  }
  const manifest = await verifyManifest(directory, options, requireFresh, onManifest, true);
  if (requireFresh && await pathExists(path.join(directory, "bundle.tar.gz"))) {
    if (!(await fs.lstat(path.join(directory, "bundle.tar.gz"))).isFile()) throw new Error("DESKTOP_RELEASE_ARCHIVE_INVALID");
    const archive = await fs.readFile(path.join(directory, "bundle.tar.gz"));
    if (archive.byteLength !== manifest.archiveSize || crypto.createHash("sha256").update(archive).digest("hex") !== manifest.archiveSha256) {
      throw new Error("DESKTOP_RELEASE_ARCHIVE_MISMATCH");
    }
  }
  return manifest;
}

/** 展开包与归档准备共用签名、平台和期限门禁；fresh 不改变轻量检查。 */
async function verifyManifest(directory: string, options: InstalledReleaseTrustOptions, requireFresh: boolean,
  onManifest?: (manifest: ReleaseBundleManifest) => void, withPayload = false): Promise<ReleaseBundleManifest> {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("DESKTOP_RELEASE_ROOT_INVALID");
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await fs.lstat(manifestPath)).isFile()) throw new Error("DESKTOP_RELEASE_MANIFEST_INVALID");
  const manifest = assertReleaseBundleManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(manifestPath))));
  onManifest?.(manifest);
  return withPayload ? await verifyReleaseBundlePayload({ verification: "installed", ...options, directory, manifest, trustedKeys: options.trustedReleaseKeys ?? {}, requireFresh })
    : verifyReleaseBundleSignature(manifest, options.trustedReleaseKeys ?? {}, { ...options, requireFresh });
}

/** 活动事实必须持久化后才记录 healthy，避免迁移库与资源指针失配。 */
async function writePointer(rootDir: string, fileName: string, value: { releaseId: string }): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  await writeDurableJson(path.join(rootDir, fileName), value);
}

/** 回退继续使用已校验的旧清单，只有对应 Client 和 Web 恢复健康才算成功。 */
async function restorePreviousRelease(rootDir: string, previousReleaseId: string | null, hooks: ReleaseSwitchHooks, options: ReleaseTrustOptions): Promise<Error | null> {
  try {
    await hooks.beforeRestore?.();
    if (!previousReleaseId) {
      await fs.rm(path.join(rootDir, ACTIVE_POINTER), { force: true });
      await hooks.restoreInitialRelease();
      return null;
    }
    const releaseDir = path.join(rootDir, "releases", previousReleaseId);
    const manifest = await verifyReleaseBundle(releaseDir, options);
    if (manifest.releaseId !== previousReleaseId) throw new Error("回退绑定包版本标识不匹配");
    await hooks.restartClient(releaseDir, manifest);
    await hooks.reloadWeb(releaseDir, manifest);
    if (!await hooks.waitHealthy(releaseDir)) throw new Error("回退绑定包健康检查失败");
    await writePointer(rootDir, ACTIVE_POINTER, { releaseId: previousReleaseId });
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
