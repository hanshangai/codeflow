export type KnowledgeDocumentChunk = { chunkId: string; content: string; heading: string; startLine: number; endLine: number };

/** 按标题和段落切分原文，保留真实行号；解析不调用模型、不改写原文。 */
export function splitKnowledgeDocument(content: string, maxCharacters = 2000, sourcePath = ""): KnowledgeDocumentChunk[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 2) throw new RangeError("知识分块长度必须为不小于 2 的整数");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const chunks: KnowledgeDocumentChunk[] = [];
  const headings: string[] = [];
  const rst = /\.rst$/i.test(sourcePath), adornments = new Map<string, number>();
  let start = 0, buffer: string[] = [], length = 0;
  let fence: { character: string; length: number } | null = null;
  /** 将已收集行段保存为独立检索单元，空白段不产生索引。 */
  const flush = (end: number) => {
    const text = buffer.join("\n");
    if (text.trim()) chunks.push({ chunkId: String(chunks.length), content: text, heading: headings.filter(Boolean).join(" / "), startLine: start + 1, endLine: end });
    buffer = []; length = 0;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const heading = !fence && !fenceLine ? /^(#{1,6}|={1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    const underline = !fence && !fenceLine && line.trim() && !/^\s/.test(line)
      ? (rst ? /^([=\-~^"'`:+*#_])\1{2,}\s*$/ : /^ {0,3}([=\-])\1*\s*$/).exec(lines[index + 1] ?? "") : null;
    let level = heading?.[1]?.length ?? 0;
    if (!level && underline) {
      const character = underline[1]!;
      if (!adornments.has(character)) adornments.set(character, adornments.size + 1);
      level = rst ? adornments.get(character)! : character === "=" ? 1 : 2;
    }
    if (level) {
      flush(index);
      headings.length = level;
      headings[level - 1] = heading?.[2] ?? line.trim();
    }
    if (fenceLine) {
      if (!fence) fence = { character: fenceLine[1]![0]!, length: fenceLine[1]!.length };
      else if (fence.character === fenceLine[1]![0] && fenceLine[1]!.length >= fence.length && !fenceLine[2]!.trim()) fence = null;
    }
    // 超长单行按字符切分，保留所在行号，避免无换行资料形成整篇索引块。
    if (line.length > maxCharacters) {
      flush(index);
      for (let offset = 0; offset < line.length;) {
        let end = Math.min(offset + maxCharacters, line.length);
        if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
        chunks.push({ chunkId: String(chunks.length), content: line.slice(offset, end), heading: headings.filter(Boolean).join(" / "), startLine: index + 1, endLine: index + 1 });
        offset = end;
      }
      continue;
    }
    if (buffer.length && length + line.length + 1 > maxCharacters) flush(index);
    if (!buffer.length) start = index;
    buffer.push(line); length += line.length + 1;
    if (!fence && !line.trim() && length >= maxCharacters / 2) flush(index + 1);
  }
  flush(lines.length);
  return chunks;
}
