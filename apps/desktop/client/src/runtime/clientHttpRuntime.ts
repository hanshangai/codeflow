import { Agent, setGlobalDispatcher } from "undici";

// 在 Client 发起 HTTP 请求前安装带上游 EOF 修复的解析器；保留原生 fetch/Response。
setGlobalDispatcher(new Agent());
