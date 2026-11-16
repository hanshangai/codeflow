import type { EngineType } from "./engine";
import type { ThreadId, TurnId, WorkspaceId } from "./ids";

export type RawEngineEventSchema = 1;

export type RawEngineEventEnvelope = {
  schema: RawEngineEventSchema;
  seq: number;
  ts: number;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: EngineType;
  source: string;
  /** Client 已确认的本地 turn 归属；仅在引擎事件可精确关联时写入。 */
  clientTurnId?: TurnId;
  data: unknown;
  handled: boolean;
  action: "mapped" | "ignored" | "unhandled" | "parseError";
  emittedTypes: string[];
};

export type RawEngineEventInput = Omit<RawEngineEventEnvelope, "schema" | "seq">;
