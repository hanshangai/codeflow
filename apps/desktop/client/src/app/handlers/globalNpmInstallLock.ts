export type ActiveGlobalNpmInstallTask = {
  label: string;
  startedAt: number;
};

type AcquireGlobalNpmInstallResult =
  | { ok: true; task: ActiveGlobalNpmInstallTask; release: () => void }
  | { ok: false; activeTask: ActiveGlobalNpmInstallTask };

let activeTask: ActiveGlobalNpmInstallTask | null = null;

/** 单 client 全局 npm 安装互斥，避免并发 `npm install -g` 互相覆盖。 */
export function acquireGlobalNpmInstall(label: string): AcquireGlobalNpmInstallResult {
  if (activeTask) {
    return { ok: false, activeTask };
  }

  const task: ActiveGlobalNpmInstallTask = {
    label: String(label ?? "").trim() || "npm install",
    startedAt: Date.now(),
  };
  activeTask = task;

  let released = false;
  return {
    ok: true,
    task,
    release: () => {
      if (released) return;
      released = true;
      if (activeTask === task) activeTask = null;
    },
  };
}

export function getActiveGlobalNpmInstall(): ActiveGlobalNpmInstallTask | null {
  return activeTask;
}

export function resetGlobalNpmInstallLockForTests(): void {
  activeTask = null;
}
