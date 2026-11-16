import type { ClientCapabilitySnapshot } from "./rpc";
import type { SharedWorkspaceTopicEvent } from "./sharedWorkspace";

export type OnlineClientInfo = {
  clientId: string;
  /** Server 根据认证和运行能力投影，旧 Server 缺字段时不得按版本猜测。 */
  runtimeSource?: "desktop" | "legacy" | "unknown";
  deviceId?: string | null;
  name?: string;
  version: string;
  platform?: string | null;
  arch?: string | null;
  connectedAt: number;
  workspaceIds: string[];
  capabilities?: ClientCapabilitySnapshot | null;
};

export type OnlineState = {
  onlineWebCount: number;
  /** client（codeflowai）是否在线（= onlineClients.length > 0）。 */
  clientOnline: boolean;
  /** 所有在线 client 列表。 */
  onlineClients: OnlineClientInfo[];
};

export type PresenceEvent =
  | { type: "presence.updated"; ts: number; payload: OnlineState }
  | SharedWorkspaceTopicEvent;
