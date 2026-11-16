import { onBeforeUnmount, onMounted, ref } from "vue";

export type ViewportMode = "mobile" | "tablet" | "desktop";

/** 响应式断点沿用布局宽度；可见高度和偏移用于避开移动端键盘。 */
export function useViewport() {
  const mode = ref<ViewportMode>(calcMode());
  const visualViewportHeight = ref(window.innerHeight);
  const visualViewportTop = ref(0);
  const viewport = window.visualViewport;

  /** 跟随键盘与浏览器工具栏变化；双指缩放时保留布局尺寸。 */
  const updateViewport = () => {
    mode.value = calcMode();
    const unscaled = viewport && viewport.scale === 1;
    visualViewportHeight.value = unscaled ? viewport.height : window.innerHeight;
    visualViewportTop.value = unscaled ? viewport.offsetTop : 0;
  };

  updateViewport();
  onMounted(() => {
    updateViewport();
    window.addEventListener("resize", updateViewport);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("resize", updateViewport);
    viewport?.removeEventListener("resize", updateViewport);
    viewport?.removeEventListener("scroll", updateViewport);
  });

  return { mode, visualViewportHeight, visualViewportTop };
}

/** 键盘和页面缩放不改变应用的响应式断点口径。 */
function calcMode(): ViewportMode {
  const w = window.innerWidth;
  if (w < 768) return "mobile";
  if (w < 1200) return "tablet";
  return "desktop";
}

