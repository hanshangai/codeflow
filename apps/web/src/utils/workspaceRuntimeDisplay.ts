import type { ActiveWorkspaceClientState, ActiveWorkspaceRuntimeState } from "../store/presence";

export type WorkspaceRuntimeDisplay = {
  subject: "client" | "host";
  status: "online" | "offline" | "unknown" | "unbound" | "forbidden";
  tone: "online" | "offline" | "unknown";
  label: string;
  title: string;
};

/** 将当前工作区运行态转换为跨端一致的 Client/Host 展示口径。 */
export function resolveWorkspaceRuntimeDisplay(
  runtime: ActiveWorkspaceRuntimeState,
  accountClientState: ActiveWorkspaceClientState,
): WorkspaceRuntimeDisplay {
  if (runtime.kind === "shared") {
    if (runtime.status === "online") {
      return { subject: "host", status: "online", tone: "online", label: "Host 在线", title: "共享工作区 Host: 在线" };
    }
    if (runtime.status === "offline") {
      return { subject: "host", status: "offline", tone: "offline", label: "Host 离线", title: "共享工作区 Host: 离线" };
    }
    if (runtime.status === "unbound") {
      return { subject: "host", status: "unbound", tone: "offline", label: "Host 未绑定", title: "共享工作区尚未绑定 Host" };
    }
    if (runtime.status === "forbidden") {
      return { subject: "host", status: "forbidden", tone: "offline", label: "Host 不可用", title: "当前账号无法访问共享工作区 Host" };
    }
    return { subject: "host", status: "unknown", tone: "unknown", label: "Host 确认中", title: "正在确认共享工作区 Host 状态" };
  }

  const status = runtime.kind === "local" ? runtime.status : accountClientState;
  if (status === "online") {
    return { subject: "client", status, tone: "online", label: "Client 在线", title: "Client: 在线" };
  }
  if (status === "unknown") {
    return { subject: "client", status, tone: "unknown", label: "Client 确认中", title: "Client: 状态确认中" };
  }
  return { subject: "client", status, tone: "offline", label: "Client 离线", title: "Client: 离线" };
}
