import { watch, nextTick, type Ref } from "vue";

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let renderCounter = 0;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
      return m;
    });
  }
  return mermaidPromise;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.15;

/**
 * 为 mermaid SVG 容器添加缩放 + 平移功能。
 *
 * 交互设计（不打断正常页面滚动）：
 *   桌面端：Ctrl+滚轮 缩放 ｜ 鼠标拖拽平移（放大后）｜ 双击重置
 *   移动端：双指捏合 缩放 ｜ 单指拖拽平移（放大后）｜ 双击重置
 *
 * 未放大时所有普通滚动/滑动事件透传给外层，不影响页面滚动。
 */
function setupZoomPan(svgContainer: HTMLElement) {
  let scale = 1;
  let translateX = 0;
  let translateY = 0;

  const svgEl = svgContainer.querySelector("svg");
  if (!svgEl) return;

  function applyTransform() {
    svgEl!.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  function clampTranslate() {
    if (scale <= 1) { translateX = 0; translateY = 0; return; }
    const rect = svgContainer.getBoundingClientRect();
    const maxPan = Math.max(rect.width, rect.height) * (scale - 1) / 2;
    translateX = Math.max(-maxPan, Math.min(maxPan, translateX));
    translateY = Math.max(-maxPan, Math.min(maxPan, translateY));
  }

  function syncZoomState() {
    const zoomed = scale > 1;
    svgContainer.classList.toggle("mermaid-block__svg--zoomed", zoomed);
    // 未放大时允许浏览器处理单指滚动；放大后 JS 全权接管
    svgContainer.style.touchAction = zoomed ? "none" : "";
  }

  function resetZoom() {
    scale = 1; translateX = 0; translateY = 0;
    applyTransform();
    syncZoomState();
  }

  // ── 桌面端：Ctrl+滚轮缩放（macOS 触控板双指捏合也会触发 ctrlKey wheel） ──
  svgContainer.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return; // 普通滚轮 → 不拦截，外层正常滚动
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
    clampTranslate();
    applyTransform();
    syncZoomState();
  }, { passive: false });

  // ── 桌面端：鼠标拖拽平移（仅放大后） ──
  let dragging = false;
  let startX = 0;
  let startY = 0;

  svgContainer.addEventListener("mousedown", (e) => {
    if (scale <= 1) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    svgContainer.classList.add("mermaid-block__svg--dragging");
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    clampTranslate();
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    svgContainer.classList.remove("mermaid-block__svg--dragging");
  });

  // ── 移动端：双指捏合缩放 + 放大后单指拖拽 ──
  let lastTouchDist = 0;
  let lastTouchMidX = 0;
  let lastTouchMidY = 0;
  let touchDragging = false;

  function getTouchDist(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  svgContainer.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      lastTouchDist = getTouchDist(e.touches[0]!, e.touches[1]!);
      lastTouchMidX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
      lastTouchMidY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
    } else if (e.touches.length === 1 && scale > 1) {
      // 放大后单指拖拽
      touchDragging = true;
      startX = e.touches[0]!.clientX - translateX;
      startY = e.touches[0]!.clientY - translateY;
    }
    // scale <= 1 时单指 → 不拦截，浏览器正常滚动页面
  }, { passive: false });

  svgContainer.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = getTouchDist(e.touches[0]!, e.touches[1]!);
      const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
      const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
      if (lastTouchDist > 0) {
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (dist / lastTouchDist)));
        translateX += midX - lastTouchMidX;
        translateY += midY - lastTouchMidY;
        clampTranslate();
        applyTransform();
        syncZoomState();
      }
      lastTouchDist = dist;
      lastTouchMidX = midX;
      lastTouchMidY = midY;
    } else if (e.touches.length === 1 && touchDragging) {
      e.preventDefault();
      translateX = e.touches[0]!.clientX - startX;
      translateY = e.touches[0]!.clientY - startY;
      clampTranslate();
      applyTransform();
    }
    // scale <= 1 时单指 → 不拦截
  }, { passive: false });

  svgContainer.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) lastTouchDist = 0;
    if (e.touches.length === 0) touchDragging = false;
  });

  // 双击重置（桌面 + 移动通用）
  svgContainer.addEventListener("dblclick", resetZoom);
}

/**
 * 扫描容器内 `.mermaid-pending` 元素，将 mermaid 源码渲染为 SVG 图表。
 * 懒加载 mermaid 库——仅在页面存在 mermaid 块时才下载。
 */
export function useMermaid(containerRef: Ref<HTMLElement | null>, htmlRef: Ref<string>) {
  watch(htmlRef, () => {
    void nextTick(async () => {
      // immediate: true 时首次回调在 setup 期间同步触发，
      // 但 nextTick 会延迟到 DOM 挂载后执行，此时 containerRef 已绑定。
      const container = containerRef.value;
      if (!container) return;

      const pending = Array.from(container.querySelectorAll(".mermaid-pending")) as HTMLElement[];
      if (!pending.length) return;

      const { default: mermaid } = await loadMermaid();

      for (const el of pending) {
        const sourceEl = el.querySelector(".mermaid-source") as HTMLPreElement | null;
        const source = sourceEl?.textContent?.trim();
        if (!source) continue;

        const id = `mermaid-svg-${++renderCounter}`;
        try {
          const { svg } = await mermaid.render(id, source);
          el.querySelector(".mermaid-block__header")?.remove();
          if (sourceEl) sourceEl.remove();
          const svgContainer = document.createElement("div");
          svgContainer.className = "mermaid-block__svg";
          svgContainer.innerHTML = svg;
          el.appendChild(svgContainer);
          el.classList.remove("mermaid-pending");
          setupZoomPan(svgContainer);
        } catch (err) {
          el.classList.remove("mermaid-pending");
          el.classList.add("mermaid-error");
          const errMsg = document.createElement("div");
          errMsg.className = "mermaid-block__error";
          errMsg.textContent = `Mermaid 渲染失败: ${err instanceof Error ? err.message : String(err)}`;
          el.insertBefore(errMsg, sourceEl);
          // clean up any leftover element that mermaid.render may have injected
          document.getElementById(id)?.remove();
        }
      }
    });
  }, { immediate: true });
}
