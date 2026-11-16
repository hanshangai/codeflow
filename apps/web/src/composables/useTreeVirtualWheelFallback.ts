import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from "vue";

type VirtualListSetupState = {
  state?: {
    scrollTop?: number;
  };
  onScrollBar?: (scrollTop: number) => void;
  delayHideScrollBar?: () => void;
};

type VirtualListControl = {
  holder: HTMLElement;
  setupState: VirtualListSetupState;
};

function resolveVirtualListControl(root: HTMLElement | null): VirtualListControl | null {
  const holder = root?.querySelector<HTMLElement>(".ant-tree-list-holder");
  const setupState = (holder as any)?.__vueParentComponent?.setupState as VirtualListSetupState | undefined;
  if (!holder || !setupState?.state || typeof setupState.onScrollBar !== "function") {
    return null;
  }
  return { holder, setupState };
}

export function useTreeVirtualWheelFallback(target: Ref<HTMLElement | null>) {
  let cleanup: (() => void) | null = null;
  let wheelFrame: number | null = null;
  let observer: MutationObserver | null = null;

  function detachWheelFallback(): void {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (wheelFrame != null) {
      cancelAnimationFrame(wheelFrame);
      wheelFrame = null;
    }
  }

  async function attachWheelFallback(): Promise<void> {
    detachWheelFallback();
    await nextTick();
    const root = target.value;
    if (!root) return;
    const initialControl = resolveVirtualListControl(root);

    const onWheel = (event: WheelEvent): void => {
      const control = resolveVirtualListControl(root);
      if (!control) return;
      if (!(event.target instanceof Node) || !control.holder.contains(event.target)) return;

      const deltaY = Number(event.deltaY ?? 0);
      if (!Number.isFinite(deltaY) || deltaY === 0) return;

      const beforeTop = Number(control.setupState.state?.scrollTop ?? 0);
      event.preventDefault();

      if (wheelFrame != null) {
        cancelAnimationFrame(wheelFrame);
      }

      wheelFrame = requestAnimationFrame(() => {
        wheelFrame = null;
        const afterTop = Number(control.setupState.state?.scrollTop ?? 0);
        if (afterTop !== beforeTop) return;
        control.setupState.onScrollBar?.(beforeTop + deltaY);
        control.setupState.delayHideScrollBar?.();
      });
    };

    root.dataset.treeVirtualWheelFallback = initialControl ? "ready" : "pending";
    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    observer = new MutationObserver(() => {
      root.dataset.treeVirtualWheelFallback = resolveVirtualListControl(root) ? "ready" : "pending";
    });
    observer.observe(root, { childList: true, subtree: true });
    cleanup = () => {
      delete root.dataset.treeVirtualWheelFallback;
      root.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    };
  }

  onMounted(() => {
    void attachWheelFallback();
  });

  onBeforeUnmount(() => {
    detachWheelFallback();
  });

  watch(target, () => {
    void attachWheelFallback();
  });

  return {
    attachWheelFallback,
    detachWheelFallback,
  };
}
