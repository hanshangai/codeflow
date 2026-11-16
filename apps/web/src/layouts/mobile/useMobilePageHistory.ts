import { nextTick, onUnmounted, ref } from "vue";
import type { Router } from "vue-router";
import type { MobilePageEntry, MobileTabKey, UiStore } from "../../store/ui";
import { resolveMobileTabForMainView } from "../../store/ui";

const ENTRY_KEY = "codeflowMobileEntry";
/** iOS 手势返回松手后的回弹动画时长；在此之前切换 DOM 会与原生动画抢帧、闪出容器底色。 */
const GESTURE_BACK_SETTLE_MS = 200;
type PageSnapshot = { pages: MobilePageEntry[]; tab: MobileTabKey };

/** 移动端页栈与浏览器历史共用一个入口；历史只保存标识，不写入文件预览内容。 */
export function useMobilePageHistory(ui: UiStore, router: Router, onTraverse: () => void) {
  const animate = ref(true);
  const transition = ref<"slide-left" | "slide-right">("slide-left");
  const restoring = ref(false);
  const snapshots = new Map<string, PageSnapshot>();
  let sequence = 0;
  const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let traversing = false;
  let restoreRun = 0;
  let pendingBack: ((handled: boolean) => void) | null = null;
  const currentUrl = () => `${location.pathname}${location.search}${location.hash}`;
  const snapshot = (): PageSnapshot => ({ pages: [...ui.mobilePageStack], tab: resolveMobileTabForMainView(ui.mainView, ui.activeMobileTab) });

  function save(mode: "push" | "replace", url = currentUrl()): void {
    const existing = window.history.state?.[ENTRY_KEY];
    const id = mode === "replace" && typeof existing === "string" && snapshots.has(existing)
      ? existing : `${session}-${++sequence}`;
    snapshots.set(id, snapshot());
    try {
      // 通过 Vue Router 的 history 实例写入，保留 position/back/current/forward 等字段。
      router.options.history[mode](url, { [ENTRY_KEY]: id });
    } catch (error) {
      console.error("[MOBILE_HISTORY_WRITE_FAILED]", {
        code: "MOBILE_HISTORY_WRITE_FAILED", requestId: null, mode,
        pageType: ui.currentMobilePage?.type ?? null,
        cause: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  save("replace");
  const unsubscribe = ui.$onAction(({ name, args, after }) => {
    if (restoring.value) return;
    if (name === "pushMobilePage") {
      const options = args[1];
      const mode = options?.history ?? "push";
      if (mode === "push") {
        save("replace");
        animate.value = true;
        transition.value = "slide-left";
      }
      after(() => save(mode, options?.url));
    } else if (name === "clearMobilePages" || name === "setActiveMobileTab") {
      after(() => { if (!restoring.value) save("replace"); });
    }
  });

  async function handleHistoryNavigation(): Promise<void> {
    const run = ++restoreRun;
    traversing = true;
    restoring.value = true;
    // iOS 已完成原生交互动画；只有按钮请求的回退保留网页动画。
    animate.value = pendingBack !== null;
    transition.value = "slide-right";
    onTraverse();
    const target = snapshots.get(window.history.state?.[ENTRY_KEY]);
    if (animate.value) {
      // 按钮返回：先刷新 css 开关再移除旧节点，避免 Vue Transition 复用旧 hooks。
      await nextTick();
    } else {
      // 手势返回：原生滑动已在视觉上完成切换，但 iOS 松手后仍会播回弹动画。
      // 此刻立即改 DOM 会与原生合成层抢帧、闪出容器底色，因此等回弹结束再切换。
      await new Promise<void>((resolve) => { window.setTimeout(resolve, GESTURE_BACK_SETTLE_MS); });
    }
    if (run !== restoreRun) return;
    ui.$patch(state => {
      state.mobilePageStack = target ? [...target.pages] : [];
      if (target) state.activeMobileTab = target.tab;
    });
    void nextTick(() => { if (run === restoreRun) restoring.value = false; });
  }
  // 与 Router 共用同一个原生事件回调，赶在异步路由守卫和 watcher 之前关闭动画。
  const removeHistoryListener = router.options.history.listen(() => { void handleHistoryNavigation(); });

  const removeAfterEach = router.afterEach(() => {
    if (!traversing && !pendingBack) {
      animate.value = true;
      transition.value = "slide-left";
    }
    if (!traversing) return;
    const run = restoreRun;
    // 等路由与页面 watcher 完成同一次渲染后，再允许后续导航。
    void nextTick(() => {
      if (run !== restoreRun) return;
      traversing = false;
      const resolve = pendingBack;
      pendingBack = null;
      resolve?.(true);
    });
  });

  async function back(): Promise<boolean> {
    if (pendingBack) return true;
    animate.value = true;
    transition.value = "slide-right";
    if (!window.history.state?.back) return false;
    return new Promise(resolve => {
      pendingBack = resolve;
      router.back();
    });
  }

  onUnmounted(() => {
    restoreRun += 1;
    unsubscribe();
    removeAfterEach();
    removeHistoryListener();
    pendingBack?.(true);
    snapshots.clear();
  });
  return { animate, transition, restoring, back };
}
