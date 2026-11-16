import {
  createWorkspacePathReference,
  parseWorkspacePathMentions,
  WORKSPACE_PATH_REFERENCE_LIMITS,
  type WorkspacePathMention,
  type WorkspacePathReference,
} from "@codeflowai/shared";

export type SubmitPathReferenceStat = {
  ok: true;
  exists: boolean;
  isDir: boolean;
} | {
  ok: false;
  message: string;
};

export type ResolveSubmitPathReferencesInput = {
  text: string;
  existingReferences: readonly WorkspacePathReference[];
  statPath?: (path: string) => Promise<SubmitPathReferenceStat>;
  onStatFailure?: (path: string, message: string) => void;
};

/**
 * 提交时只携带可确认的结构化路径引用；普通正文里的 @xxx 保留为文本，不阻断发送。
 */
export async function resolveSubmitPathReferences(input: ResolveSubmitPathReferencesInput): Promise<WorkspacePathReference[]> {
  const mentions = parseWorkspacePathMentions(input.text);
  const existingByPath = new Map(input.existingReferences.map((ref) => [ref.path, ref] as const));
  const seen = new Set<string>();
  const refs: WorkspacePathReference[] = [];

  for (const mention of mentions) {
    if (seen.has(mention.path)) continue;
    seen.add(mention.path);

    const existing = existingByPath.get(mention.path);
    if (existing) {
      appendPathReference(refs, existing);
      continue;
    }

    if (!input.statPath || !shouldStatTypedMention(mention)) continue;
    try {
      const stat = await input.statPath(mention.path);
      if (!stat.ok) {
        input.onStatFailure?.(mention.path, stat.message || "路径引用状态查询失败");
        continue;
      }
      if (!stat.exists) continue;
      appendPathReference(refs, createWorkspacePathReference({
        path: mention.path,
        kind: stat.isDir ? "directory" : "file",
        source: "mention",
      }));
    } catch (error) {
      input.onStatFailure?.(mention.path, error instanceof Error ? error.message : String(error));
    }
  }

  return refs;
}

/** 判断手输 @ token 是否足够像路径，避免把 @RateLimiter 这类普通文本拿去 stat。 */
function shouldStatTypedMention(mention: WorkspacePathMention): boolean {
  if (mention.quoted || mention.lineSuffix) return true;
  const rawBody = mention.raw.slice(1);
  return /[\\/]/u.test(rawBody) || rawBody.includes(".");
}

/** 追加结构化引用并按 payload 上限显式失败。 */
function appendPathReference(refs: WorkspacePathReference[], ref: WorkspacePathReference): void {
  refs.push(createWorkspacePathReference(ref));
  if (refs.length > WORKSPACE_PATH_REFERENCE_LIMITS.maxCount) {
    throw new Error(`最多只能引用 ${WORKSPACE_PATH_REFERENCE_LIMITS.maxCount} 个工作区路径`);
  }
}
