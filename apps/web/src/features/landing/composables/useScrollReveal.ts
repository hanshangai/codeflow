import { onMounted, onUnmounted, type Ref } from "vue";

/**
 * IntersectionObserver composable：元素进入视口时添加 `revealed` class，
 * 触发 CSS 定义的 fade-in + translateY 动画。
 *
 * @param containerRef - 包含 `[data-reveal]` 元素的容器 ref
 * @param options - threshold / rootMargin 自定义
 */
export function useScrollReveal(
  containerRef: Ref<HTMLElement | null>,
  options: { threshold?: number; rootMargin?: string } = {},
) {
  let observer: IntersectionObserver | null = null;

  onMounted(() => {
    const el = containerRef.value;
    if (!el) return;

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).classList.add("revealed");
            observer?.unobserve(entry.target);
          }
        }
      },
      { threshold: options.threshold ?? 0.15, rootMargin: options.rootMargin ?? "0px 0px -40px 0px" },
    );

    const targets = el.querySelectorAll("[data-reveal]");
    targets.forEach((t) => observer!.observe(t));
  });

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
  });
}
