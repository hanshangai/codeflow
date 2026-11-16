import type { EngineType } from "./engine";

/**
 * 引擎调用追踪（用于排障与复现）。
 * - 绑定到 user message item 下展示“完整参数”
 * - 事件会随 `EngineEventEnvelope` 落库（Client SQLite）
 * - 为避免 DB 膨胀：`stream-json` 的图片 base64 会被脱敏为占位符
 */
export type EngineCallTrace =
  | EngineCallTraceSpawn
  | EngineCallTraceJsonRpc;

export type EngineCallTraceSpawn = {
  kind: "spawn";
  engine: EngineType;
  cwd: string;
  command: string;
  args: string[];
  stdin: EngineCallStdinTrace;
};

export type EngineCallStdinTrace =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | {
      kind: "stream-json";
      /** 单行 JSON（图片 base64 会被替换为占位符，便于落库与复制）。 */
      line: string;
      redacted: boolean;
    };

export type EngineCallTraceJsonRpc = {
  kind: "jsonrpc";
  engine: EngineType;
  transport: "codex-app-server";
  cwd: string;
  requests: Array<{
    method: string;
    params?: unknown;
  }>;
};

