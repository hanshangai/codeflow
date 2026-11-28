const WEB_CITATION = /\uE200cite(?:\uE202turn\d+[a-z]+\d+)+\uE201/gu;
const WEB_CITATION_LINE = new RegExp(String.raw`^[ \t]*(?:${WEB_CITATION.source}[ \t]*)+\r?\n`, "gmu");

/** 清理展示用的网页引用编号，也处理输出中断后保存的残缺引用。 */
export function formatAssistantMessageText(text: string, streaming: boolean): string {
  const start = text.lastIndexOf("\uE200");
  if (start < 0) return text;
  const tail = text.slice(start + 1);
  if ((streaming || tail.startsWith("cite\uE202")) && isPartialWebCitation(tail)) {
    text = text.slice(0, start);
  }
  return text.replace(WEB_CITATION_LINE, "").replace(WEB_CITATION, "");
}

/** 仅识别末尾可以接续成已知引用格式的片段。 */
function isPartialWebCitation(tail: string): boolean {
  if ("cite".startsWith(tail)) return true;
  const match = /^cite(?:\uE202turn\d+[a-z]+\d+)*\uE202([a-z0-9]*)$/u.exec(tail);
  if (!match) return false;
  const reference = match[1]!;
  return "turn".startsWith(reference) || /^turn\d+(?:[a-z]+\d*)?$/u.test(reference);
}
