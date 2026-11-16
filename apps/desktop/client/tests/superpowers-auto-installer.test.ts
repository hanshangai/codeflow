import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installSuperpowersIfMissing } from "../src/skills/superpowersAutoInstaller.ts";
import { SKILLS_TARGETS } from "../src/skills/skillsTargets.ts";

/** 两个目标都已有安装状态时，启动任务必须静默跳过且不触发下载。 */
test("Superpowers already installed in every target is skipped", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superpowers-auto-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const target of SKILLS_TARGETS) {
    const stateDir = path.join(target.resolveSkillsRoot(root), "_community");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "obra-superpowers.json"), JSON.stringify({
      suiteId: "obra-superpowers",
      installedAt: 1,
      entries: ["brainstorming"],
    }), "utf8");
  }
  const result = await installSuperpowersIfMissing({ workspaces: new Map([["client:workspace" as never, root]]) });
  assert.deepEqual(result, { installed: 0, skipped: 1, failed: 0 });
});
