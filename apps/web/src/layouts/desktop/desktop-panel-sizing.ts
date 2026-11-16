export const LEFT_SIDEBAR_MIN_WIDTH = 300;
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 360;
export const LEFT_SIDEBAR_MAX_WIDTH = 520;
export const LEFT_SIDEBAR_COLLAPSED_RAIL_WIDTH = 0;
export const DESKTOP_WORK_MAIN_MIN_WIDTH = 440;
export const DESKTOP_TERMINAL_MAIN_MIN_WIDTH = 400;

export type DesktopRightPanelMode = "inspector" | "explorer" | "terminal" | null;

/** 渲染时 clamp 用的右面板最小宽度；explorer 必须与 store/ui.ts 的 EXPLORER_PANEL_MIN_WIDTH 同值，否则拖到下限会被弹回。 */
const RIGHT_PANEL_MIN_WIDTH: Record<Exclude<DesktopRightPanelMode, null>, number> = {
  inspector: 280,
  explorer: 300,
  terminal: 480,
};

const RIGHT_PANEL_MAX_WIDTH = 700;

export function normalizeLeftSidebarWidth(value: unknown, fallback = LEFT_SIDEBAR_DEFAULT_WIDTH): number {
  return typeof value === "number" && Number.isFinite(value) && value >= LEFT_SIDEBAR_MIN_WIDTH && value <= LEFT_SIDEBAR_MAX_WIDTH
    ? Math.round(value)
    : fallback;
}

/** Resolves the desktop layout track without changing the persisted width preference. */
export function resolveLeftSidebarTrackWidth(input: {
  collapsed: boolean;
  effectiveLeftWidth: number;
}): number {
  if (input.collapsed) return LEFT_SIDEBAR_COLLAPSED_RAIL_WIDTH;
  return normalizeLeftSidebarWidth(input.effectiveLeftWidth);
}

export type DesktopPanelSizing = {
  effectiveLeftWidth: number;
  effectiveLeftMaxWidth: number;
  effectiveRightWidth: number;
  mainWidth: number;
};

/**
 * Resolves the visible three-column geometry without writing back temporary constraints
 * to the user's left-sidebar preference. Right panels give up width before the left panel.
 */
export function resolveDesktopPanelSizing(input: {
  containerWidth: number;
  leftPreference: unknown;
  rightMode: DesktopRightPanelMode;
  rightPreference?: number;
}): DesktopPanelSizing {
  const containerWidth = Math.max(0, Number(input.containerWidth) || 0);
  const leftPreference = normalizeLeftSidebarWidth(input.leftPreference);
  if (!input.rightMode) {
    const effectiveLeftMaxWidth = Math.max(
      LEFT_SIDEBAR_MIN_WIDTH,
      Math.min(LEFT_SIDEBAR_MAX_WIDTH, containerWidth - DESKTOP_WORK_MAIN_MIN_WIDTH),
    );
    const effectiveLeftWidth = Math.min(leftPreference, effectiveLeftMaxWidth);
    return {
      effectiveLeftWidth,
      effectiveLeftMaxWidth,
      effectiveRightWidth: 0,
      mainWidth: Math.max(0, containerWidth - effectiveLeftWidth),
    };
  }

  const rightMinWidth = RIGHT_PANEL_MIN_WIDTH[input.rightMode];
  const mainMinWidth = input.rightMode === "terminal"
    ? DESKTOP_TERMINAL_MAIN_MIN_WIDTH
    : DESKTOP_WORK_MAIN_MIN_WIDTH;
  const rightPreference = Number.isFinite(Number(input.rightPreference))
    ? Math.round(Number(input.rightPreference))
    : rightMinWidth;
  const boundedRightPreference = Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(rightMinWidth, rightPreference));

  // Preserve the preferred left width where possible, then shrink the right panel to its minimum.
  let effectiveRightWidth = Math.min(
    boundedRightPreference,
    Math.max(rightMinWidth, containerWidth - leftPreference - mainMinWidth),
  );
  let effectiveLeftWidth = leftPreference;
  if (effectiveLeftWidth + effectiveRightWidth + mainMinWidth > containerWidth) {
    effectiveLeftWidth = Math.max(
      LEFT_SIDEBAR_MIN_WIDTH,
      Math.min(leftPreference, containerWidth - effectiveRightWidth - mainMinWidth),
    );
  }
  if (effectiveLeftWidth + effectiveRightWidth + mainMinWidth > containerWidth) {
    effectiveRightWidth = Math.max(rightMinWidth, containerWidth - effectiveLeftWidth - mainMinWidth);
  }
  const effectiveLeftMaxWidth = Math.max(
    LEFT_SIDEBAR_MIN_WIDTH,
    Math.min(LEFT_SIDEBAR_MAX_WIDTH, containerWidth - rightMinWidth - mainMinWidth),
  );

  const resolvedLeftWidth = Math.min(effectiveLeftWidth, effectiveLeftMaxWidth);
  return {
    effectiveLeftWidth: resolvedLeftWidth,
    effectiveLeftMaxWidth,
    effectiveRightWidth,
    mainWidth: Math.max(0, containerWidth - resolvedLeftWidth - effectiveRightWidth),
  };
}
