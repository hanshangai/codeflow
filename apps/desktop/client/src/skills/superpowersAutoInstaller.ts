import type { WorkspaceId } from "@codeflowai/shared";
import { SKILL_SUITES_REGISTRY } from "@codeflowai/shared";

import { logger } from "../logger.js";
import { getCommunitySkillsStatus, installCommunitySkills } from "./communitySkillsInstaller.js";

const SUPERPOWERS_SUITE_ID = "obra-superpowers";

/** 启动时为缺失 Superpowers 的本地工作区静默安装；已完整安装的工作区不重复下载。 */
export async function installSuperpowersIfMissing(input: {
  workspaces: Map<WorkspaceId, string>;
}): Promise<{ installed: number; skipped: number; failed: number }> {
  const suite = SKILL_SUITES_REGISTRY.find((item) => item.suiteId === SUPERPOWERS_SUITE_ID);
  if (!suite) throw new Error("SUPERPOWERS_SUITE_REGISTRY_MISSING");
  let installed = 0;
  let skipped = 0;
  let failed = 0;
  for (const [workspaceId, workspacePath] of input.workspaces) {
    const status = getCommunitySkillsStatus(suite, workspacePath);
    if (status.every((target) => target.ready)) {
      skipped += 1;
      continue;
    }
    const results = await installCommunitySkills({ suite, workspacePath, targets: status.map((item) => item.targetId) });
    const failures = results.filter((item) => !item.ok);
    if (failures.length) {
      failed += 1;
      logger.error("skills", "superpowers silent install failed", {
        code: "SUPERPOWERS_SILENT_INSTALL_FAILED",
        workspaceId,
        suiteId: suite.suiteId,
        failedTargets: failures.map((item) => ({ targetId: item.targetId, rootCause: item.message ?? null })),
      });
      continue;
    }
    installed += 1;
    logger.info("skills", "superpowers silent install completed", {
      code: "SUPERPOWERS_SILENT_INSTALLED",
      workspaceId,
      suiteId: suite.suiteId,
      targets: results.map((item) => item.targetId),
    });
  }
  return { installed, skipped, failed };
}
