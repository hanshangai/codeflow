export type OrchestrationEntry = "workspace" | "assets";

type RouteNameLike = string | symbol | null | undefined;

function normalizeRouteName(routeName: RouteNameLike): string {
  return String(routeName ?? "").trim();
}

export function resolveOrchestrationEntryFromRouteName(routeName: RouteNameLike): OrchestrationEntry | null {
  const name = normalizeRouteName(routeName);
  if (name === "orchestration-assets") return "assets";
  if (name === "orchestration-workspace") return "workspace";
  return null;
}

export function resolveOrchestrationEntryForTopLevelNavigation(opts: {
  routeName: RouteNameLike;
  lastVisitedEntry: OrchestrationEntry | null | undefined;
}): OrchestrationEntry {
  return resolveOrchestrationEntryFromRouteName(opts.routeName) ?? opts.lastVisitedEntry ?? "workspace";
}
