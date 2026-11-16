import { onMounted, onUnmounted, ref } from "vue";
import { message } from "ant-design-vue";

type WindowControlResult = { ok: true } | { ok: false; error: unknown };

/** 无边框桌面窗口控制；旧壳不提供时 controls 为 null，调用方不渲染按钮。 */
export function useDesktopWindowControls() {
  const controls = typeof window !== "undefined" ? window.codeflowDesktop?.windowControls ?? null : null;
  const maximized = ref(false);
  let dispose: (() => void) | undefined;
  let disposed = false;
  let hasEvent = false;

  /** 在原 UI 边界提示并返回失败，原始原因（含 falsy 值）不丢失。 */
  function fail(action: string, label: string, error: unknown): WindowControlResult {
    console.error("desktop_window_control_failed", {
      code: `DESKTOP_WINDOW_${action}_FAILED`, requestId: null, action,
      rootCause: error instanceof Error ? error.message : `native rejection (${typeof error})`,
    });
    if (!disposed) message.error(`${label}失败，请重试`);
    return { ok: false, error };
  }

  onMounted(async () => {
    if (!controls) return;
    try {
      // 先订阅再取状态：事件一旦到达，压过较慢的一次性响应。
      dispose = controls.onStateChange(state => {
        hasEvent = true;
        if (!disposed) maximized.value = state.maximized;
      });
      const state = await controls.getState();
      if (!disposed && !hasEvent) maximized.value = state.maximized;
      return { ok: true };
    } catch (error) {
      return fail("STATE", "读取窗口状态", error);
    }
  });

  onUnmounted(() => {
    disposed = true;
    const release = dispose;
    dispose = undefined;
    try { release?.(); }
    catch (error) { fail("SUBSCRIPTION", "释放窗口状态订阅", error); throw error; }
  });

  /** 最小化当前窗口；返回明确结果，避免点击事件产生未处理拒绝。 */
  async function minimize(): Promise<WindowControlResult> {
    try {
      if (!controls) throw new Error("DESKTOP_WINDOW_CONTROLS_UNAVAILABLE");
      await controls.minimize();
      return { ok: true };
    } catch (error) { return fail("MINIMIZE", "最小化窗口", error); }
  }

  /** 切换最大化；事件已推送时以事件为准，避免较慢的响应覆盖新状态。 */
  async function toggleMaximize(): Promise<WindowControlResult> {
    try {
      if (!controls) throw new Error("DESKTOP_WINDOW_CONTROLS_UNAVAILABLE");
      const state = await controls.toggleMaximize();
      if (!disposed && !hasEvent) maximized.value = state.maximized;
      return { ok: true };
    } catch (error) {
      return fail("MAXIMIZE", "切换窗口大小", error);
    }
  }

  /** 关闭窗口；主进程会按既有边界隐藏到托盘而不是退出。 */
  async function close(): Promise<WindowControlResult> {
    try {
      if (!controls) throw new Error("DESKTOP_WINDOW_CONTROLS_UNAVAILABLE");
      await controls.close();
      return { ok: true };
    } catch (error) { return fail("CLOSE", "关闭窗口", error); }
  }

  return { controls, maximized, minimize, toggleMaximize, close };
}
