/**
 * 刷新请求常在几十毫秒内返回，转圈会一闪而过；点击后至少展示这么久，保证有可见反馈。
 * 取 antd loading 一个完整旋转周期（1s）——短于它动画会停在中途，看起来像「转一下卡住」。
 */
export const REFRESH_MIN_FEEDBACK_MS = 1000;

/**
 * 从 startedAt 起补足最短反馈时长；已超过则立即返回。
 * 用于刷新按钮的转圈动画：请求时长不可控，但「转一下就没了」等于没有反馈。
 */
export function holdRefreshFeedback(
  startedAt: number,
  minMs: number = REFRESH_MIN_FEEDBACK_MS,
): Promise<void> {
  const remaining = minMs - (Date.now() - startedAt);
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}
