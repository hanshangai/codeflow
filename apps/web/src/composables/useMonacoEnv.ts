/**
 * Monaco Editor worker 初始化（Vite 环境）。
 * 全局只需执行一次。
 *
 * 关键点：
 * - 不能把所有 label 都路由到 `editor.worker`
 * - `json/css/html/typescript` 会向各自语言 worker 发送专有 RPC（如 json 的 schema 相关方法）
 * - 若错误地返回通用 editor worker，会出现：
 *   `Missing requestHandler or method: resetSchema`
 */

let initialized = false;

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export function ensureMonacoEnv(): void {
  if (initialized) return;
  initialized = true;

  (self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    },
  };
}
