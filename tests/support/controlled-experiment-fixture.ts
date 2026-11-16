import { ControlledExperimentExecutor } from "../../apps/desktop/client/src/experiments/controlledExperimentExecutor.ts";
import type { ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

/** 普通 handler 测试也会转交实验执行器引用；只有真正启动实验才显式失败。 */
export function createUnusedExperimentExecutor(db: ClientDb): ControlledExperimentExecutor {
  const unexpected = (): never => { throw new Error("Unexpected experiment session operation in handler fixture"); };
  return new ControlledExperimentExecutor({
    db,
    workspaces: new Map(),
    sessions: {
      createIsolatedSession: unexpected,
      getWorkspacePath: unexpected,
      interruptCodexTurnByEngineIds: unexpected,
      reconcileCodexDanglingTurn: unexpected,
    },
  });
}
