declare module "word-extractor" {
  export default class WordExtractor {
    /** 从内存中的 DOC/DOCX 提取正文及辅助文本，不启动外部程序。 */
    extract(buffer: Buffer): Promise<{
      getBody(): string;
      getFootnotes(): string;
      getEndnotes(): string;
      getHeaders(): string;
      getTextboxes(): string;
    }>;
  }
}
