export type TerminalId = string;
export type TerminalStatus = "running" | "stopped" | "exited";

export type TerminalInfo = {
  id: TerminalId;
  workspaceId: string;
  label: string;
  shell: string | null;
  cwd: string | null;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: number;
  foregroundProcess: string | null;
};

/** Web 侧可跨工作区识别的终端信息；clientId 由 Server 根据已认证连接补充。 */
export type AccountTerminalInfo = TerminalInfo & {
  clientId: string;
};

/** Client 本机实际可启动的终端 Shell 选项。 */
export type TerminalShellOption = {
  value: string;
  label: string;
};

/** 自定义操作按钮（用于终端弹窗 header 区快捷命令）。 */
export type TerminalAction = {
  id: string;
  label: string;
  command: string;
  /** Shell 可执行路径，null 表示使用系统默认 shell。 */
  shell: string | null;
  cwd: string | null;
  icon: string | null;
  color: string | null;
  order: number;
  /** 是否在新建终端时自动执行。 */
  autoRun: boolean;
  /** 是否启用（禁用时不在 header 显示按钮）。 */
  enabled: boolean;
};
