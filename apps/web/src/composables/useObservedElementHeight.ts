import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

export function useObservedElementHeight(target: Ref<HTMLElement | null>) {
  const observedHeight = ref(0);
  let resizeObserver: ResizeObserver | null = null;

  function refreshObservedHeight(): void {
    const nextHeight = Math.max(Math.floor(target.value?.clientHeight ?? 0), 0);
    if (nextHeight !== observedHeight.value) {
      observedHeight.value = nextHeight;
    }
  }

  function stopObserving(): void {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  async function reconnectObservedHeight(): Promise<void> {
    stopObserving();
    await nextTick();
    refreshObservedHeight();
    if (typeof ResizeObserver === "undefined" || !target.value) return;
    resizeObserver = new ResizeObserver(() => {
      refreshObservedHeight();
    });
    resizeObserver.observe(target.value);
  }

  onMounted(() => {
    void reconnectObservedHeight();
  });

  onBeforeUnmount(() => {
    stopObserving();
  });

  watch(target, () => {
    void reconnectObservedHeight();
  });

  return {
    observedHeight,
    refreshObservedHeight,
    reconnectObservedHeight,
  };
}
