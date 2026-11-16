import path from "node:path";

export type SkillsTargetId = "codex" | "claude";

export type SkillsTargetDef = {
  targetId: SkillsTargetId;
  label: string;
  /** 解析 workspace 下该目标的 skillsRoot（绝对路径）。 */
  resolveSkillsRoot: (workspacePath: string) => string;
};

/** skills 安装目标定义：后续接入新客户端只需在这里追加一项即可。 */
export const SKILLS_TARGETS: SkillsTargetDef[] = [
  { targetId: "codex", label: "Codex", resolveSkillsRoot: (ws) => path.join(ws, ".codex", "skills") },
  { targetId: "claude", label: "Claude", resolveSkillsRoot: (ws) => path.join(ws, ".claude", "skills") },
];

/** 根据 targetId 获取目标定义（不存在返回 null）。 */
export function findSkillsTarget(targetId: string): SkillsTargetDef | null {
  const id = String(targetId ?? "").trim();
  return SKILLS_TARGETS.find((t) => t.targetId === id) ?? null;
}

