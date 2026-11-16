import type { AccessMode, ApprovalOption } from "@codeflowai/shared";
import type { ConversationProfile } from "../threadSession.js";

export type ClaudeControlMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";
export type ClaudeApprovalKind = "generic" | "enterPlanMode" | "exitPlanMode";

export type ClaudeApprovalDescriptor = {
  approvalKind: ClaudeApprovalKind;
  message: string;
  options?: ApprovalOption[];
};

export type ClaudeApprovalResponse = {
  response: {
    behavior: "allow";
    updatedPermissions?: Array<Record<string, unknown>>;
  } | {
    behavior: "deny";
    message: string;
  };
  nextMode: ClaudeControlMode;
  clearContextRequested: boolean;
  followUp?: {
    kind: "clearContextAndSend";
    promptText: string;
    accessMode: "current" | "full-access";
  };
  resolutionMessage?: string;
};

const EXIT_PLAN_OPTION_BYPASS_CLEAR = "yes-bypass-permissions";
const EXIT_PLAN_OPTION_ACCEPT_CLEAR = "yes-accept-edits";
const EXIT_PLAN_OPTION_KEEP_CONTEXT = "yes-accept-edits-keep-context";
const EXIT_PLAN_OPTION_MANUAL = "yes-default-keep-context";
const EXIT_PLAN_OPTION_STAY = "no";

const ENTER_PLAN_OPTION_YES = "yes";
const ENTER_PLAN_OPTION_NO = "no";

export function resolveClaudeControlMode(opts: {
  planMode: boolean;
  accessMode: AccessMode;
  conversationProfile?: ConversationProfile | null;
}): ClaudeControlMode {
  if (opts.planMode) return "plan";
  if (opts.accessMode === "full-access") return "bypassPermissions";
  if (opts.accessMode === "read-only" && opts.conversationProfile === "orchestration") return "default";
  if (opts.accessMode === "read-only") return "plan";
  return "acceptEdits";
}

export function isAskUserQuestionTool(toolName: string): boolean {
  return toolName.toLowerCase() === "askuserquestion";
}

export function isExitPlanModeTool(toolName: string): boolean {
  return toolName.toLowerCase() === "exitplanmode";
}

export function isEnterPlanModeTool(toolName: string): boolean {
  return toolName.toLowerCase() === "enterplanmode";
}

export function isInteractiveControlTool(toolName: string): boolean {
  return isAskUserQuestionTool(toolName) || isExitPlanModeTool(toolName) || isEnterPlanModeTool(toolName);
}

export function buildClaudeApprovalDescriptor(opts: {
  toolName: string;
  prePlanMode: ClaudeControlMode | null;
}): ClaudeApprovalDescriptor {
  if (isExitPlanModeTool(opts.toolName)) {
    const bypassAvailable = opts.prePlanMode === "bypassPermissions";
    return {
      approvalKind: "exitPlanMode",
      message: "Claude 已完成计划，等待您决定是否开始实施。",
      options: [
        {
          value: bypassAvailable ? EXIT_PLAN_OPTION_BYPASS_CLEAR : EXIT_PLAN_OPTION_ACCEPT_CLEAR,
          label: bypassAvailable ? "是，清空上下文并绕过权限" : "是，清空上下文并自动接受编辑",
          description: "继续开始实现，并切换到更宽松的执行模式。",
          intent: "accept",
        },
        {
          value: EXIT_PLAN_OPTION_KEEP_CONTEXT,
          label: bypassAvailable ? "是，并绕过权限" : "是，自动接受编辑",
          description: "保留当前上下文，继续开始实现。",
          intent: "accept",
        },
        {
          value: EXIT_PLAN_OPTION_MANUAL,
          label: "是，手动审批编辑",
          description: "退出计划模式，但后续工具执行继续逐次确认。",
          intent: "accept",
        },
        {
          value: EXIT_PLAN_OPTION_STAY,
          label: "否，继续规划",
          description: "补充新的要求，让 Claude 继续调整方案。",
          intent: "decline",
          requiresNote: true,
          notePlaceholder: "输入要调整或补充的点",
        },
      ],
    };
  }

  if (isEnterPlanModeTool(opts.toolName)) {
    return {
      approvalKind: "enterPlanMode",
      message: "Claude 想先进入计划模式，先分析再给出实施方案。",
      options: [
        {
          value: ENTER_PLAN_OPTION_YES,
          label: "是，进入计划模式",
          description: "Claude 先分析和规划，不直接改代码。",
          intent: "accept",
        },
        {
          value: ENTER_PLAN_OPTION_NO,
          label: "否，直接开始实现",
          description: "保持当前模式，继续直接执行。",
          intent: "decline",
        },
      ],
    };
  }

  return {
    approvalKind: "generic",
    message: "Claude 请求使用工具，请确认是否继续。",
  };
}

export function buildClaudeApprovalResponse(opts: {
  toolName: string;
  decision: "accept" | "decline";
  choice?: string | null;
  note?: string | null;
  currentMode: ClaudeControlMode;
  prePlanMode: ClaudeControlMode | null;
  plan?: string | null;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}): ClaudeApprovalResponse {
  if (isEnterPlanModeTool(opts.toolName)) {
    if (opts.decision === "accept") {
      return {
        response: {
          behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
        },
        nextMode: "plan",
        clearContextRequested: false,
      };
    }
    return {
      response: {
        behavior: "deny",
        message: opts.note?.trim() || "保持当前模式，不进入计划模式",
      },
      nextMode: opts.currentMode,
      clearContextRequested: false,
    };
  }

  if (isExitPlanModeTool(opts.toolName)) {
    const choice = String(opts.choice ?? "").trim() || (opts.decision === "decline" ? EXIT_PLAN_OPTION_STAY : EXIT_PLAN_OPTION_MANUAL);
    if (choice === EXIT_PLAN_OPTION_STAY || opts.decision === "decline") {
      return {
        response: {
          behavior: "deny",
          message: opts.note?.trim() || "继续保持计划模式",
        },
        nextMode: "plan",
        clearContextRequested: false,
      };
    }

    const bypassPreferred = opts.prePlanMode === "bypassPermissions";
    const targetMode = choice === EXIT_PLAN_OPTION_MANUAL
      ? "default"
      : choice === EXIT_PLAN_OPTION_BYPASS_CLEAR
        ? "bypassPermissions"
        : choice === EXIT_PLAN_OPTION_ACCEPT_CLEAR
          ? "acceptEdits"
          : bypassPreferred
            ? "bypassPermissions"
            : "acceptEdits";

    const updatedPermissions: Array<Record<string, unknown>> = [
      { type: "setMode", mode: targetMode, destination: "session" },
    ];
    if (Array.isArray(opts.allowedPrompts) && opts.allowedPrompts.length > 0) {
      const promptRules = opts.allowedPrompts
        .filter((p) => typeof p?.tool === "string" && typeof p?.prompt === "string")
        .map((p) => ({ toolName: p.tool, ruleContent: `prompt: ${p.prompt.trim()}` }));
      if (promptRules.length > 0) {
        updatedPermissions.push({
          type: "addRules",
          rules: promptRules,
          behavior: "allow",
          destination: "session",
        });
      }
    }

    const clearContextRequested = choice === EXIT_PLAN_OPTION_BYPASS_CLEAR || choice === EXIT_PLAN_OPTION_ACCEPT_CLEAR;
    const response = clearContextRequested
      ? {
          behavior: "deny" as const,
          message: "切换为清空上下文后的实现流程",
        }
      : {
          behavior: "allow" as const,
          updatedPermissions,
        };
    return {
      response,
      nextMode: targetMode,
      clearContextRequested,
      followUp: clearContextRequested
        ? {
            kind: "clearContextAndSend",
            promptText: buildClearContextPrompt(opts),
            accessMode: targetMode === "bypassPermissions" ? "full-access" : "current",
          }
        : undefined,
      resolutionMessage: clearContextRequested ? "即将清空上下文，并按计划自动开始实现。" : undefined,
    };
  }

  if (opts.decision === "accept") {
    return {
      response: { behavior: "allow" },
      nextMode: opts.currentMode,
      clearContextRequested: false,
    };
  }
  return {
    response: {
      behavior: "deny",
      message: opts.note?.trim() || "用户拒绝",
    },
    nextMode: opts.currentMode,
    clearContextRequested: false,
  };
}

function buildClearContextPrompt(opts: { plan?: string | null }): string {
  const plan = String(opts.plan ?? "").trim();
  if (!plan.trim()) return "Implement the approved plan.";
  return `Implement the following plan:\n\n${plan}\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), refer back to the earlier conversation history.`;
}

