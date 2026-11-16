import { createApp } from "vue";
import "ant-design-vue/dist/reset.css";

import App from "./App.vue";
import router from "./router";
import { migrateConfigDefaults } from "./store/config";
import { migrateUiRightPanelState } from "./store/ui";
import { pinia } from "./store/pinia";
import "./styles.css";
import { installBaiduTracking } from "./analytics/analytics";

installMobileZoomGuards();
installModalKeyboardShortcuts();
installBaiduTracking();

const app = createApp(App);
migrateUiRightPanelState();
app.use(pinia).use(router);
migrateConfigDefaults();
// 首路由解析完成后再挂载，避免 H5 深链先加载默认 Web 工作台。
await router.isReady();
app.mount("#app");
document.body.classList.remove("app-booting");

/** 弹框键盘操作：Enter 触发最上层弹框的确定按钮；Esc 由 antd 默认关闭。 */
function installModalKeyboardShortcuts(): void {
  if (typeof window === "undefined") return;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.defaultPrevented || event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // 多行输入、下拉/选择器/菜单内部回车用于自身操作，不能当作确认。
    if (target.closest("textarea, [contenteditable='true'], .ant-select, .ant-picker, .ant-cascader, .ant-mentions, .ant-dropdown, .ant-popover")) return;
    // 焦点在按钮或链接上时保留原生回车行为（例如聚焦“取消”时回车应取消）。
    if (target.closest("button, a")) return;
    if (document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-picker-dropdown:not(.ant-picker-dropdown-hidden)")) return;
    const modal = topVisibleModal();
    // 只响应弹框内的键盘焦点，避免后台页面误触确认。
    if (!modal || !modal.contains(target)) return;
    const primary = modal.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary:not([disabled]):not(.ant-btn-dangerous)");
    if (!primary) return;
    event.preventDefault();
    primary.click();
  });
}

/** 取当前最上层可见弹框，支持多层弹框叠放。 */
function topVisibleModal(): HTMLElement | null {
  const wraps = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-wrap"))
    .filter((wrap) => getComputedStyle(wrap).display !== "none");
  return wraps.sort((left, right) => Number(getComputedStyle(left).zIndex || 0) - Number(getComputedStyle(right).zIndex || 0)).at(-1) ?? null;
}

function installMobileZoomGuards(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const hasTouch = (navigator.maxTouchPoints ?? 0) > 0 || window.matchMedia?.("(pointer: coarse)").matches;
  if (!hasTouch) return;

  const preventGesture = (event: Event) => {
    if ((event.target as Element)?.closest?.(".mermaid-block__svg")) return;
    event.preventDefault();
  };

  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      // 放行 mermaid 图表区域内的双指手势，允许局部缩放
      if ((event.target as Element)?.closest?.(".mermaid-block__svg")) return;
      event.preventDefault();
    }
  };

  document.addEventListener("gesturestart", preventGesture, { passive: false });
  document.addEventListener("gesturechange", preventGesture, { passive: false });
  document.addEventListener("gestureend", preventGesture, { passive: false });
  document.addEventListener("touchmove", preventPinch, { passive: false });
}
