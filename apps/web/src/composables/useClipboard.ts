/**
 * 安全写入剪贴板（兼容非 HTTPS 上下文）。
 * 优先使用 Clipboard API，不可用时回退到 execCommand("copy")。
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // fallback: execCommand
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("复制失败");
  } finally {
    document.body.removeChild(textarea);
  }
}
