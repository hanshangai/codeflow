import type { ItemId, ThreadId, TurnId, WorkspaceId } from "./ids";

export type RequestUserInputOption = {
  label: string;
  description: string;
};

export type RequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  options?: RequestUserInputOption[];
  /** true = 多选（checkbox），false/undefined = 单选（radio）。 */
  multiSelect?: boolean;
};

export type RequestUserInputParams = {
  /** 异步提问作为后续用户输入回答，不持有等待中的 provider RPC。 */
  delivery?: "async";
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  questions: RequestUserInputQuestion[];
};

/** 引擎向用户请求输入（Web 需要展示表单并提交答案）。 */
export type RequestUserInputRequest = {
  requestId: number | string;
  params: RequestUserInputParams;
};

export type RequestUserInputAnswer = {
  answers: string[];
};

/** Web 提交的用户输入答案（透传回引擎）。 */
export type RequestUserInputResponse = {
  requestId: number | string;
  answers: Record<string, RequestUserInputAnswer>;
};

