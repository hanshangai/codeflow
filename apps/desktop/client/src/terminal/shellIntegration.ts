/**
 * Shell Integration (OSC 133) — 终端待机/运行中精准检测
 *
 * 通过注入 shell init 脚本，让 shell 主动通过 OSC 133 转义序列上报
 * "命令开始/结束"，实现精准的 idle/busy 状态切换。
 *
 * 这是 VS Code、Windows Terminal、WezTerm 等主流终端使用的行业标准。
 */

// ---------------------------------------------------------------------------
// 1. Shell 类型检测
// ---------------------------------------------------------------------------

export type ShellType = "powershell" | "pwsh" | "bash" | "zsh" | "fish" | "cmd" | "unknown";

/** 从 shell 可执行路径推断 shell 类型。 */
export function detectShellType(shellPath: string): ShellType {
  const base = shellPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const name = base.replace(/\.exe$/i, "");

  if (name === "pwsh" || name === "pwsh-preview") return "pwsh";
  if (name === "powershell") return "powershell";
  if (name === "bash") return "bash";
  if (name === "zsh") return "zsh";
  if (name === "fish") return "fish";
  if (name === "cmd") return "cmd";
  return "unknown";
}

// ---------------------------------------------------------------------------
// 2. Init 脚本生成
// ---------------------------------------------------------------------------

/**
 * 返回用于注入到 PTY 的 shell init 脚本。
 * 返回 null 表示该 shell 不支持 OSC 133（CMD、unknown）。
 *
 * 脚本会：
 * - 用环境变量 `__CODEFLOWAI_SHELL_INTEGRATION` 防止重复注入
 * - 注册 prompt / preexec 钩子发出 OSC 133 A/B/C/D 序列
 */
export function getShellInitScript(shellType: ShellType): string | null {
  switch (shellType) {
    case "bash":
      return getBashInitScript();
    case "zsh":
      return getZshInitScript();
    case "powershell":
    case "pwsh":
      return getPowerShellInitScript();
    case "fish":
      return getFishInitScript();
    case "cmd":
    case "unknown":
      return null;
  }
}

function getBashInitScript(): string {
  // Bash >= 4.4: PROMPT_COMMAND (array) + PS0
  // PROMPT_COMMAND 发出 D;$? + A，PS0 发出 C
  return [
    `if [ -z "$__CODEFLOWAI_SHELL_INTEGRATION" ]; then`,
    `  __CODEFLOWAI_SHELL_INTEGRATION=1`,
    `  __codeflowai_prompt_cmd() {`,
    `    local ec=$?`,
    `    builtin printf '\\e]133;D;%d\\a' "$ec"`,
    `    builtin printf '\\e]133;A\\a'`,
    `  }`,
    `  if [[ -z "$PROMPT_COMMAND" ]]; then`,
    `    PROMPT_COMMAND=__codeflowai_prompt_cmd`,
    `  else`,
    `    PROMPT_COMMAND="__codeflowai_prompt_cmd;\${PROMPT_COMMAND}"`,
    `  fi`,
    `  PS0='\\[\\e]133;C\\a\\]'`,
    `fi`,
  ].join("\n");
}

function getZshInitScript(): string {
  // Zsh: precmd + preexec
  return [
    `if [[ -z "$__CODEFLOWAI_SHELL_INTEGRATION" ]]; then`,
    `  __CODEFLOWAI_SHELL_INTEGRATION=1`,
    `  __codeflowai_precmd() {`,
    `    builtin printf '\\e]133;D;%d\\a' "$?"`,
    `    builtin printf '\\e]133;A\\a'`,
    `  }`,
    `  __codeflowai_preexec() {`,
    `    builtin printf '\\e]133;C\\a'`,
    `  }`,
    `  precmd_functions+=(__codeflowai_precmd)`,
    `  preexec_functions+=(__codeflowai_preexec)`,
    `fi`,
  ].join("\n");
}

function getPowerShellInitScript(): string {
  // PowerShell / pwsh: 重写 prompt 函数 + PSReadLine Enter handler
  // 编码为单行命令，避免 PSReadLine 将多行注入当作交互式粘贴并进入续行状态。
  const script = [
    `if (-not $env:__CODEFLOWAI_SHELL_INTEGRATION) {`,
    `  $env:__CODEFLOWAI_SHELL_INTEGRATION = "1"`,
    `  $__codeflowai_origPrompt = $function:prompt`,
    `  function prompt {`,
    `    $ec = if ($?) { 0 } else { 1 }`,
    `    [Console]::Write("$([char]27)]133;D;$ec$([char]7)")`,
    `    [Console]::Write("$([char]27)]133;A$([char]7)")`,
    `    $r = & $__codeflowai_origPrompt`,
    `    [Console]::Write("$([char]27)]133;B$([char]7)")`,
    `    return $r`,
    `  }`,
    `  Import-Module PSReadLine -ErrorAction Stop`,
    `  Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {`,
    `    [Console]::Write("$([char]27)]133;C$([char]7)")`,
    `    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()`,
    `  }`,
    `}`,
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `. ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
}

/** 返回 PowerShell 启动参数，使集成脚本在进入交互模式前完成且不回显。 */
export function getShellLaunchArgs(shellType: ShellType): string[] {
  if (shellType !== "powershell" && shellType !== "pwsh") return [];
  const initScript = getShellInitScript(shellType);
  return initScript ? ["-NoLogo", "-NoExit", "-Command", initScript] : [];
}

function getFishInitScript(): string {
  // Fish: fish_prompt + fish_preexec event
  return [
    `if not set -q __CODEFLOWAI_SHELL_INTEGRATION`,
    `  set -gx __CODEFLOWAI_SHELL_INTEGRATION 1`,
    `  function __codeflowai_fish_prompt --on-event fish_prompt`,
    `    printf '\\e]133;D;%d\\a' $status`,
    `    printf '\\e]133;A\\a'`,
    `  end`,
    `  function __codeflowai_fish_preexec --on-event fish_preexec`,
    `    printf '\\e]133;C\\a'`,
    `  end`,
    `end`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 3. OSC 133 解析器
// ---------------------------------------------------------------------------

export type Osc133Event =
  | { type: "prompt_start" }         // 133;A — shell 空闲，显示 prompt
  | { type: "prompt_end" }           // 133;B — prompt 绘制完毕，等待输入
  | { type: "command_start" }        // 133;C — 用户按下回车，命令即将执行
  | { type: "command_end"; exitCode: number }; // 133;D;exitCode — 命令执行结束

/**
 * OSC 133 序列匹配：
 * - `\x1b]133;A\x07`           → prompt_start
 * - `\x1b]133;B\x07`           → prompt_end
 * - `\x1b]133;C\x07`           → command_start
 * - `\x1b]133;D;(\d+)\x07`    → command_end with exit code
 * - `\x1b]133;D\x07`          → command_end with exit code 0 (implicit)
 *
 * 也支持 ST 终结符 `\x1b\\` 替代 `\x07`。
 */
const OSC_133_RE = /\x1b\]133;([ABCD])(?:;(\d+))?(?:\x07|\x1b\\)/g;

/**
 * 从 PTY 输出中提取所有 OSC 133 事件。
 * 返回空数组表示无事件。
 */
export function parseOsc133(data: string): Osc133Event[] {
  const events: Osc133Event[] = [];
  let match: RegExpExecArray | null;
  OSC_133_RE.lastIndex = 0;
  while ((match = OSC_133_RE.exec(data)) !== null) {
    const code = match[1];
    switch (code) {
      case "A":
        events.push({ type: "prompt_start" });
        break;
      case "B":
        events.push({ type: "prompt_end" });
        break;
      case "C":
        events.push({ type: "command_start" });
        break;
      case "D":
        events.push({ type: "command_end", exitCode: match[2] ? parseInt(match[2], 10) : 0 });
        break;
    }
  }
  return events;
}

/**
 * 从数据中剥离 OSC 133 转义序列，返回清理后的数据。
 * 用于避免这些控制序列出现在终端的可见输出中（大多数终端模拟器已自行处理，
 * 但部分情况下 scrollback 记录可能包含原始序列）。
 */
export function stripOsc133(data: string): string {
  return data.replace(OSC_133_RE, "");
}

// ---------------------------------------------------------------------------
// 4. 状态机
// ---------------------------------------------------------------------------

export type ShellPhase = "idle" | "busy";

export type ShellIntegrationState = {
  /** 是否已收到过 OSC 133;A（shell integration 正常工作的标志）。 */
  active: boolean;
  /** 当前阶段。 */
  phase: ShellPhase;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { active: false, phase: "idle" };
}

/**
 * 根据 OSC 133 事件更新状态机。
 * 返回 phase 是否发生了变化。
 */
export function applyOsc133Events(
  state: ShellIntegrationState,
  events: Osc133Event[],
): boolean {
  let changed = false;
  for (const event of events) {
    switch (event.type) {
      case "prompt_start": {
        // 133;A — shell 回到 prompt，即空闲
        if (!state.active) {
          state.active = true;
        }
        if (state.phase !== "idle") {
          state.phase = "idle";
          changed = true;
        }
        break;
      }
      case "command_start": {
        // 133;C — 命令开始执行
        if (state.phase !== "busy") {
          state.phase = "busy";
          changed = true;
        }
        break;
      }
      case "command_end": {
        // 133;D — 命令结束（随后通常紧跟 133;A，但也单独处理以确保健壮）
        if (state.phase !== "idle") {
          state.phase = "idle";
          changed = true;
        }
        break;
      }
      case "prompt_end":
        // 133;B — prompt 绘制完毕，不影响 idle/busy
        break;
    }
  }
  return changed;
}

