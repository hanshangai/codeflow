import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  privateCliNpmPackage,
  type PrivateCliEngine,
} from "../../cli-runtime/privateCliManifest.js";
import {
  parsePrivateCliRuntimeEntry,
  type PrivateCliRuntimeEntry,
} from "../../cli-runtime/privateCliPaths.js";
import {
  commitPrivateCliStaging,
  defaultPrivateCliProbe,
  type PrivateCliInstallResult,
  type PrivateCliProbe,
} from "./privateCliRuntime.js";

/** 离线包不可用（缺失、runtime.json 非法、版本不匹配或 bin 缺失）时的稳定错误码。 */
export const PRIVATE_CLI_OFFLINE_INVALID = "PRIVATE_CLI_OFFLINE_INVALID";

/** 对外离线导入参数：只允许固定目录布局，不接受调用方传入任意源路径。 */
export type PrivateCliOfflineImportInput = {
  root: string;
  engine: PrivateCliEngine;
  version: string;
  requestId: string;
};

/** 构造带稳定 code 的离线包错误，便于安装结果按 code 归类。 */
function codedError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(
    new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause }),
    { code },
  );
}

/** 判断是否为本模块抛出的带 code 错误，避免重复叠加错误码前缀。 */
function isCodedCliError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("PRIVATE_CLI_");
}

/**
 * 离线包固定目录：`<root>/offline/<engine>`。
 * 位置由应用决定，调用方无法指定任意路径，避免路径穿越或被误导入其他目录。
 */
export function privateCliOfflineDirectory(root: string, engine: PrivateCliEngine): string {
  return path.join(path.resolve(root), "offline", engine);
}

/** 判断离线包目录是否存在；只把 ENOENT 当作不存在，其他文件系统错误原样上抛。 */
export async function privateCliOfflineDirectoryExists(
  root: string,
  engine: PrivateCliEngine,
): Promise<boolean> {
  try {
    const stats = await fs.stat(privateCliOfflineDirectory(root, engine));
    return stats.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 同步判断目录存在，供同步的离线源解析使用。 */
function isDirectorySync(target: string): boolean {
  try {
    return fsSync.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读取并严格解析离线包内的 runtime.json。
 * 任何读取/解码/字段/引擎/包名/相对 binPath 问题都视为无效离线包并返回 null。
 */
function readOfflineRuntimeEntry(
  directory: string,
  engine: PrivateCliEngine,
): PrivateCliRuntimeEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fsSync.readFileSync(path.join(directory, "runtime.json"), "utf8"));
  } catch {
    return null;
  }
  try {
    return parsePrivateCliRuntimeEntry(raw, engine);
  } catch {
    return null;
  }
}

/**
 * 校验目录内的 runtime.json 版本与固定版本一致，且记录的 bin 实际存在。
 * 通过返回运行时记录，否则返回 null；供离线源解析与复制后复核共用。
 */
function verifiedOfflineEntry(
  directory: string,
  engine: PrivateCliEngine,
  version: string,
): PrivateCliRuntimeEntry | null {
  const entry = readOfflineRuntimeEntry(directory, engine);
  if (entry === null || entry.version !== version) return null;
  try {
    if (!fsSync.statSync(path.join(directory, entry.binPath)).isFile()) return null;
  } catch {
    return null;
  }
  return entry;
}

/**
 * 返回可用的离线包目录；仅在目录存在、runtime.json 合法、engine/包名/版本匹配
 * 且记录的 bin 存在时返回源目录，否则返回 null（不抛错，便于安装入口区分存在性）。
 */
export function offlinePrivateCliSource(
  root: string,
  engine: PrivateCliEngine,
  version: string,
): string | null {
  const directory = privateCliOfflineDirectory(root, engine);
  if (!isDirectorySync(directory)) return null;
  return verifiedOfflineEntry(directory, engine, version) === null ? null : directory;
}

/**
 * 从固定离线目录导入私有 CLI：复制到全新 staging、复核 runtime.json 与 bin、
 * 复用与网络安装相同的探测与原子替换流程，全程不执行 npm。
 * 离线包缺失或非法时显式返回 PRIVATE_CLI_OFFLINE_INVALID，不静默回退网络。
 */
export async function installPrivateCliFromOffline(
  input: PrivateCliOfflineImportInput,
): Promise<PrivateCliInstallResult> {
  return await installPrivateCliFromOfflineSource(input);
}

/**
 * 离线导入的低层入口，允许内部调用方注入探测，保证与网络安装使用同一套收尾流程。
 */
export async function installPrivateCliFromOfflineSource(
  input: PrivateCliOfflineImportInput & { probe?: PrivateCliProbe },
): Promise<PrivateCliInstallResult> {
  const root = path.resolve(input.root);
  const probe = input.probe ?? defaultPrivateCliProbe;
  let staging: string | null = null;

  const failure = (error: string): PrivateCliInstallResult => ({
    success: false,
    installedVersion: null,
    output: "",
    error,
    attempts: [],
  });

  try {
    // 先在复制前校验源包，避免把明显非法的目录复制进运行时。
    const source = offlinePrivateCliSource(root, input.engine, input.version);
    if (source === null) {
      const exists = await privateCliOfflineDirectoryExists(root, input.engine);
      throw codedError(
        PRIVATE_CLI_OFFLINE_INVALID,
        exists
          ? `离线包校验未通过：要求版本 ${input.version}，且 runtime.json 与记录的 bin 必须有效`
          : "未找到预置离线包目录",
      );
    }

    await fs.mkdir(root, { recursive: true });
    staging = path.join(root, `.staging-${input.engine}-${randomUUID()}`);
    await fs.cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    // 复制后按同一规则复核 staging，防止复制过程产生损坏的运行时。
    if (verifiedOfflineEntry(staging, input.engine, input.version) === null) {
      throw codedError(PRIVATE_CLI_OFFLINE_INVALID, "复制后的离线包 runtime.json 或 bin 校验失败");
    }

    const entry = await commitPrivateCliStaging({
      root,
      engine: input.engine,
      version: input.version,
      npmPackage: privateCliNpmPackage(input.engine),
      staging,
      probe,
    });
    staging = null;

    return {
      success: true,
      installedVersion: entry.version,
      output: "",
      error: null,
      attempts: [],
    };
  } catch (error) {
    // 失败只清理 staging；旧运行时由 commitPrivateCliStaging 内部的原子替换负责恢复。
    if (staging) {
      try {
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        // staging 清理失败不掩盖原始错误。
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(isCodedCliError(error) ? message : `${PRIVATE_CLI_OFFLINE_INVALID}: ${message}`);
  }
}
