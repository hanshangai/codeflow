const REPLACEMENT_CHARACTER_MARKER = "\uFFFD";
const GBK_MOJIBAKE_MARKER = "\u951F\u65A4\u62F7";
const UTF8_MOJIBAKE_MARKER = "\u00EF\u00BF\u00BD";
const LATIN1_MOJIBAKE_PREFIX = "\u00C3";

export const TEXT_EDITING_SAFETY_RULES = [
  "修改含中文、非 ASCII 文本或前端页面文案的源码时，必须保持原文件 UTF-8 编码；优先使用当前引擎提供的原生文件编辑能力做最小差异修改，禁止通过 PowerShell 重定向、Out-File、未显式编码的 Set-Content/Add-Content 或整文件重写方式修改源码。",
  `读取或命令输出出现 \`${REPLACEMENT_CHARACTER_MARKER}\`、\`${GBK_MOJIBAKE_MARKER}\`、\`${UTF8_MOJIBAKE_MARKER}\`、\`${LATIN1_MOJIBAKE_PREFIX}\` 等疑似中文乱码时，不得把终端乱码当成源码事实，也不得直接改写文件；必须先用 UTF-8 方式读取文件、查看 git diff 或运行 UTF-8 检查脚本确认文件真实内容。`,
  "修改后必须查看目标文件 diff，确认中文文案和非 ASCII 文本未被编码破坏。",
  "修改含中文、非 ASCII 文本或前端页面文案的文件后，必须仅针对本次实际改动的文本文件执行当前仓库可用的 UTF-8 检查；如果当前仓库存在 `scripts/check-utf8.mjs`，优先执行 `node scripts/check-utf8.mjs <本次改动文件>`，否则使用项目已有脚本、Node/Python UTF-8 解码校验、git diff 人工核查等价方式，不得因缺少该脚本直接判定验证失败；如无法确认文件真实内容、检查失败或发现疑似乱码，必须立即停止并向用户报告失败文件、异常现象和当前状态，未经用户确认不得继续修改、暂存、提交或宣称完成。",
] as const;
