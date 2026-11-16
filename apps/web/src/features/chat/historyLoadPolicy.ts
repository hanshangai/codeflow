export const INITIAL_HISTORY_MIN_VISIBLE_ITEMS = 8;
export const INITIAL_HISTORY_MAX_AUTO_PAGES = 2;
const SCROLLABLE_SLACK_PX = 24;

export type InitialHistoryAutofillInput = {
  hasMore: boolean;
  loadingMore: boolean;
  userScrolled: boolean;
  displayItemCount: number;
  scrollHeight: number;
  clientHeight: number;
  passCount: number;
  minVisibleItems?: number;
  maxAutoPages?: number;
};

export type UserScrollHistoryLoadInput = {
  hasMore: boolean;
  loadingMore: boolean;
  blockingThreadLoading: boolean;
};

export type UnscrollableWheelHistoryLoadInput = UserScrollHistoryLoadInput & {
  deltaY: number;
  scrollHeight: number;
  clientHeight: number;
};

/** 用户主动滚到顶部时是否允许分页；运行中会话由 Store 合并 live 事件。 */
export function canLoadMoreHistoryOnUserScroll(input: UserScrollHistoryLoadInput): boolean {
  if (input.blockingThreadLoading) return false;
  if (!input.hasMore) return false;
  if (input.loadingMore) return false;
  return true;
}

/** 无滚动条时，用户向上滚轮是否应直接触发历史分页。 */
export function canLoadMoreHistoryOnUnscrollableWheel(input: UnscrollableWheelHistoryLoadInput): boolean {
  if (input.deltaY >= 0) return false;
  if (isHistoryScrollable(input.scrollHeight, input.clientHeight)) return false;
  return canLoadMoreHistoryOnUserScroll(input);
}

/** 首屏历史是否还需要继续自动补页。 */
export function shouldAutofillInitialHistory(input: InitialHistoryAutofillInput): boolean {
  if (!input.hasMore || input.loadingMore || input.userScrolled) return false;

  const maxAutoPages = input.maxAutoPages ?? INITIAL_HISTORY_MAX_AUTO_PAGES;
  if (input.passCount >= maxAutoPages) return false;

  const minVisibleItems = input.minVisibleItems ?? INITIAL_HISTORY_MIN_VISIBLE_ITEMS;
  const isScrollable = isHistoryScrollable(input.scrollHeight, input.clientHeight);

  return input.displayItemCount < minVisibleItems || !isScrollable;
}

export function isHistoryScrollable(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > SCROLLABLE_SLACK_PX;
}
