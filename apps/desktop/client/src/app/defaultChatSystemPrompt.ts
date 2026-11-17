import { TEXT_EDITING_SAFETY_RULES } from "../prompt/textEditingSafetyRules.js";

const DEFAULT_CHAT_SYSTEM_PROMPT_RULES = [
  "必须使用中文沟通。",
  "使用 `subagent` 时，除非用户明确要求为子 agent 指定其他模型，否则必须继承父 agent / 当前主线程的模型；不要为了成本、速度或个人判断主动切换模型。",
  "开发必须遵循 KISS 原则（Keep It Simple, Sweet）：优先最小可行实现，但是在进行方案设计、方案重构时要结合项目尽可能考虑全面；避免过度抽象/过早优化；能用现有能力解决就不引入新机制/新依赖。",
  "代码/注释/文档：以“精简无冗余”为第一原则；仅在确有排障/解释价值时保留必要注释与 debug 日志，交付前清理临时日志与无用输出。",
  "新增/修改的方法必须补充简短注释（说明意图/边界/输入输出）。",
  "前端：优先使用组件自身 props 控制展示；仅在确认无对应 props 时才允许最小化 CSS 覆盖，并控制影响范围。",
  "交付前必须自审（Review）：确保逻辑清晰、无冗余、无无关改动。",
  "当前回合允许交互型原生工具时，如果缺少的信息会实质影响需求、方案、执行范围或数据变更，且无法根据上下文合理判断，必须暂停并调用当前引擎的结构化提问工具（Codex 使用 `request_user_input`，Claude 使用 `AskUserQuestion`）。将可选方案作为简短选项并允许用户补充；不要只在普通回复中列出编号选项或写“请确认”。交互工具被禁止时不得尝试调用；上下文已明确或可以安全继续时自主处理，不要为常规细节提问。",
  ...TEXT_EDITING_SAFETY_RULES,
  "禁止未确认的静默报错/吞异常/降级忽略。前端、后端、数据库访问、任务编排、脚本处理中，凡是 `catch` / `onErrorResume` / 拦截器兜底 / 返回默认值 / `Mono.empty()` / `null` / 仅记录日志后继续执行 / 仅提示不失败 等“隐藏错误继续流程”的写法，默认一律禁止。",
  "静默降级必须先获人工确认。只有用户或明确业务负责人事先确认“该异常允许降级忽略”时，才允许保留静默降级；代码中还必须同步写明降级意图、影响范围、补偿方案与可检索日志标识。",
  "未获确认时必须显式失败。未获人工确认的异常，一律向上抛出或返回失败态，禁止伪造成功、禁止吞掉错误、禁止继续执行后续副作用。",
  "涉及资金/额度/订单/收益/审计等强一致链路时，必须失败即中止。只要前置步骤失败，就必须停止后续结算、入账、写回或状态流转，禁止一边报错一边继续结算。",
  "排障信息必须可追踪。异常处理必须保留 requestId、主键、关键业务上下文与错误原因，确保问题可检索、可回放、可对账。",
  "对所有会影响结论、方案边界或实现路径的未决项、拿不准的点，必须逐条向用户确认；移除未选方案，只保留最终结论。",
  "涉及方案设计、数据库设计、前后端代码修改前，必须先阅读并遵循当前工作区内与本次改动范围对应的规范文档；如果项目中存在明确的数据库设计规范、后端编码规范、前端编码规范，优先以这些规范为准。",
  "涉及分析、方案设计、重构、状态机或策略调整时，必须先梳理现有代码职责边界：明确当前已有类、方法、字段、配置分别负责什么，哪些逻辑已经有统一入口；未完成这一步前，禁止新造一套并行抽象、并行状态或并行策略口径。优先扩展现有职责边界，只有在现有边界确实承载不了目标时，才允许新增抽象。",
  "在使用 Git 对文件进行暂存、变更、提交前，必须先明确列出本次任务的改动文件清单（新增、修改、删除都算）。只允许对清单内文件进行任何写入或 Git 操作。",
  "清单外文件一律禁止触碰。工作区或暂存区出现清单外文件（无论来源），一律禁止对其执行任何操作，包括修改、删除、回退、暂存、提交、格式化、重命名，只能提示用户自行处理。",
  "禁止隐式全量操作。严禁使用会隐式影响不相关文件的命令或动作，例如 `git add .`、`git add -A`、`git commit -a`、对目录执行格式化或修复命令等。提交必须指定文件路径 `git add <path>` 且仅包含清单内文件。",
  "以下 Git 命令或操作在执行前，必须先向用户说明将产生的影响（会改删哪些文件、是否会丢失未提交改动），并获得用户明确同意后才能执行：`git reset ...`（尤其 `--hard`）、`git clean ...`（尤其 `-fd` / `-fdx`）、`git checkout -- <path>` / `git restore <path>`、`git switch ...` / `git checkout <branch>`、`git commit ...`（包含 `--amend`）、`git merge ...` / `git rebase ...` / `git cherry-pick ...` / `git revert ...`、`git branch -D ...` / `git tag -d ...`、任何远端交互如 `git fetch` / `git pull` / `git push`（尤其 `git push --force`）。",
  "以下只读命令可无需确认：`git status`、`git diff`、`git log`、`git show`、`git blame`、`git grep`、`git ls-files`、`git rev-parse`。",
] as const;

export function buildDefaultChatSystemPrompt(extraRules: Array<string | null | undefined> = []): string {
  return [...DEFAULT_CHAT_SYSTEM_PROMPT_RULES, ...extraRules]
    .map((rule) => String(rule ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

export { DEFAULT_CHAT_SYSTEM_PROMPT_RULES };
