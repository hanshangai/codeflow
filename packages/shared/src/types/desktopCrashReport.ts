/** 桌面壳崩溃事件类型；仅覆盖主进程、渲染进程、GPU/Utility 和 Client 子进程。 */
export const DESKTOP_CRASH_EVENTS = [
  "main_uncaught_exception",
  "main_unhandled_rejection",
  "renderer_process_gone",
  "child_process_gone",
  "client_process_exit",
  "abnormal_exit",
] as const;
export type DesktopCrashEvent = typeof DESKTOP_CRASH_EVENTS[number];

export const DESKTOP_CRASH_REASONS = [
  "exception", "rejection", "crashed", "oom", "killed", "launch-failed", "integrity-failed", "abnormal-exit", "unknown",
] as const;
export type DesktopCrashReason = typeof DESKTOP_CRASH_REASONS[number];

export const DESKTOP_CRASH_PROCESS_TYPES = ["main", "renderer", "gpu", "utility", "client"] as const;
export type DesktopCrashProcessType = typeof DESKTOP_CRASH_PROCESS_TYPES[number];

/** 崩溃上下文版本，只接受短标识；未知信息保持 null，不推测。 */
export type DesktopCrashVersions = {
  shellVersion: string | null;
  webVersion: string | null;
  clientVersion: string | null;
  releaseId: string | null;
  shellId: string | null;
};

/** 崩溃前最近的结构化错误摘要；不包含 message、stack 或任意扩展字段。 */
export type DesktopCrashRecentError = {
  at: string;
  errorCode: string;
  requestId: string | null;
  channel: string | null;
  method: string | null;
};

/** 堆栈只保留脱敏后的调用帧，限制帧数与总长度。 */
export const DESKTOP_CRASH_STACK_MAX_FRAMES = 40;
export const DESKTOP_CRASH_STACK_MAX_LENGTH = 16_384;

/** 单条崩溃报告；payloadSha256 覆盖除自身外的全部脱敏字段。 */
export type DesktopCrashReport = {
  schemaVersion: 1;
  kind: "crash";
  reportId: string;
  deviceId: string | null;
  sessionId: string;
  sessionStartedAt: string;
  event: DesktopCrashEvent;
  processType: DesktopCrashProcessType;
  reason: DesktopCrashReason;
  exitCode: number | null;
  occurredAt: string;
  detectedAt: string;
  phase: string | null;
  errorCode: string | null;
  requestId: string | null;
  causeCodes: string[];
  recentErrors: DesktopCrashRecentError[];
  versions: DesktopCrashVersions;
  platform: "win32" | "darwin" | null;
  arch: "x64" | "arm64" | null;
  /** 仅主进程未捕获异常/未处理拒绝提供脱敏调用帧；旧报告可省略。 */
  stack?: string | null;
  payloadSha256: string;
};

export type DesktopCrashReportAck = { reportId: string; deviceId: string; payloadSha256: string };

/** 启动会话标记；下次启动据此判定上次是否异常退出。 */
export type DesktopCrashSessionMarker = {
  schemaVersion: 1;
  sessionId: string;
  startedAt: string;
  deviceId: string | null;
  versions: DesktopCrashVersions;
  platform: "win32" | "darwin" | null;
  arch: "x64" | "arm64" | null;
};

/** 正常退出标记，只证明指定会话已走完进程退出钩子。 */
export type DesktopCrashCleanMarker = { schemaVersion: 1; sessionId: string; cleanAt: string };
