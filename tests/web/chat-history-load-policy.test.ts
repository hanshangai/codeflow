import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_HISTORY_MAX_AUTO_PAGES,
  INITIAL_HISTORY_MIN_VISIBLE_ITEMS,
  canLoadMoreHistoryOnUnscrollableWheel,
  canLoadMoreHistoryOnUserScroll,
  isHistoryScrollable,
  shouldAutofillInitialHistory,
} from "../../apps/web/src/features/chat/historyLoadPolicy.ts";

test("shouldAutofillInitialHistory requests more pages when visible items are too few", () => {
  assert.equal(shouldAutofillInitialHistory({
    hasMore: true,
    loadingMore: false,
    userScrolled: false,
    displayItemCount: INITIAL_HISTORY_MIN_VISIBLE_ITEMS - 2,
    scrollHeight: 320,
    clientHeight: 320,
    passCount: 0,
  }), true);
});

test("shouldAutofillInitialHistory stops when content is already scrollable and visible enough", () => {
  assert.equal(shouldAutofillInitialHistory({
    hasMore: true,
    loadingMore: false,
    userScrolled: false,
    displayItemCount: INITIAL_HISTORY_MIN_VISIBLE_ITEMS + 2,
    scrollHeight: 820,
    clientHeight: 320,
    passCount: 0,
  }), false);
});

test("shouldAutofillInitialHistory respects max auto pages and user scrolling", () => {
  assert.equal(shouldAutofillInitialHistory({
    hasMore: true,
    loadingMore: false,
    userScrolled: false,
    displayItemCount: 1,
    scrollHeight: 320,
    clientHeight: 320,
    passCount: INITIAL_HISTORY_MAX_AUTO_PAGES,
  }), false);

  assert.equal(shouldAutofillInitialHistory({
    hasMore: true,
    loadingMore: false,
    userScrolled: true,
    displayItemCount: 1,
    scrollHeight: 320,
    clientHeight: 320,
    passCount: 0,
  }), false);
});

test("isHistoryScrollable requires a real viewport gap", () => {
  assert.equal(isHistoryScrollable(343, 320), false);
  assert.equal(isHistoryScrollable(420, 320), true);
});

test("canLoadMoreHistoryOnUserScroll allows manual pagination while a thread is running", () => {
  assert.equal(canLoadMoreHistoryOnUserScroll({
    hasMore: true,
    loadingMore: false,
    blockingThreadLoading: false,
  }), true);

  assert.equal(canLoadMoreHistoryOnUserScroll({
    hasMore: false,
    loadingMore: false,
    blockingThreadLoading: false,
  }), false);

  assert.equal(canLoadMoreHistoryOnUserScroll({
    hasMore: true,
    loadingMore: true,
    blockingThreadLoading: false,
  }), false);

  assert.equal(canLoadMoreHistoryOnUserScroll({
    hasMore: true,
    loadingMore: false,
    blockingThreadLoading: true,
  }), false);
});

test("canLoadMoreHistoryOnUnscrollableWheel handles upward intent without a scroll event", () => {
  const base = {
    hasMore: true,
    loadingMore: false,
    blockingThreadLoading: false,
    scrollHeight: 835,
    clientHeight: 835,
  };

  assert.equal(canLoadMoreHistoryOnUnscrollableWheel({ ...base, deltaY: -100 }), true);
  assert.equal(canLoadMoreHistoryOnUnscrollableWheel({ ...base, deltaY: 100 }), false);
  assert.equal(canLoadMoreHistoryOnUnscrollableWheel({ ...base, deltaY: -100, scrollHeight: 1200 }), false);
  assert.equal(canLoadMoreHistoryOnUnscrollableWheel({ ...base, deltaY: -100, loadingMore: true }), false);
});
