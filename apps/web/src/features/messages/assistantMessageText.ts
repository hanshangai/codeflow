const WEB_CITATION = /\uE200cite(?:\uE202turn\d+[a-z]+\d+)+\uE201/gu;

/** 从展示文本移除没有来源地址的网页引用编号，流式输出时同时隐藏末尾未收齐的标记。 */
export function formatAssistantMessageText(text: string, streaming: boolean): string {
  if (streaming) {
    const start = text.lastIndexOf("\uE200");
    if (start >= 0 && isPartialWebCitation(text.slice(start + 1))) text = text.slice(0, start);
  }
  return text.replace(WEB_CITATION, "");
}

/** 仅识别末尾可以接续成已知引用格式的片段。 */
function isPartialWebCitation(tail: string): boolean {
  if ("cite".startsWith(tail)) return true;
  const match = /^cite(?:\uE202turn\d+[a-z]+\d+)*\uE202([a-z0-9]*)$/u.exec(tail);
  if (!match) return false;
  const reference = match[1]!;
  return "turn".startsWith(reference) || /^turn\d+(?:[a-z]+\d*)?$/u.test(reference);
}
