import assert from "node:assert/strict";
import test from "node:test";

import {
  ThreadInputContractError,
  CODEX_CLI_SLASH_COMMANDS,
  CODEX_CLI_DEBUG_SLASH_COMMANDS,
  buildCodexCliSlashInputActions as buildCodexCliSlashInputActionsRaw,
  findFirstEnabledThreadInputActionIndex,
  findCodexSkillPickerToken,
  findRawSlashToken,
  insertCodexSkillMention,
  parseCodexSlashCommand,
  moveThreadInputActionSelection,
  normalizeThreadInputContract,
  rebaseCodexSkillMentionsAfterEdit,
  resolveCodexHostInputAction,
  resolveLegacyEffectiveInputKind,
  trimThreadTextWithSkillMentions,
} from "../../packages/shared/src/inputActions.ts";

const SKILL_ID = `csk_${"a".repeat(43)}`;

/** 先验证运行时判别字段，再读取只有宿主 Slash 才有的属性。 */
function buildCodexCliSlashInputActions(input: Parameters<typeof buildCodexCliSlashInputActionsRaw>[0]) {
  const actions = buildCodexCliSlashInputActionsRaw(input);
  assert.ok(actions.every((action) => action.kind === "slash" && action.source === "codeflow"));
  return actions;
}

test("inputKind only treats an absent property as legacy-auto", () => {
  assert.deepEqual(normalizeThreadInputContract({}, "hello"), {});
  assert.throws(
    () => normalizeThreadInputContract({ inputKind: null }, "hello"),
    (error) => error instanceof ThreadInputContractError && error.code === "BAD_REQUEST",
  );
  assert.throws(
    () => normalizeThreadInputContract({ inputKind: "legacy-auto" }, "hello"),
    (error) => error instanceof ThreadInputContractError && error.code === "BAD_REQUEST",
  );
});

test("skill binding requires explicit message and an exact UTF-16 token range", () => {
  const text = "请使用 $review 处理";
  const binding = { skillId: SKILL_ID, name: "review", start: 4, end: 11 };
  assert.deepEqual(normalizeThreadInputContract({ inputKind: "message", skillMentions: [binding] }, text), {
    inputKind: "message",
    skillMentions: [binding],
  });
  assert.deepEqual(normalizeThreadInputContract({ skillMentions: [] }, text), {});
  assert.throws(
    () => normalizeThreadInputContract({ skillMentions: [binding] }, text),
    (error) => error instanceof ThreadInputContractError && error.code === "CODEX_SKILL_BINDING_INVALID",
  );
  assert.throws(
    () => normalizeThreadInputContract({ inputKind: "message", skillMentions: [{ ...binding, start: 5 }] }, text),
    (error) => error instanceof ThreadInputContractError && error.code === "CODEX_SKILL_BINDING_INVALID",
  );
});

test("raw Slash parsing preserves index zero and exact Codex compact matching", () => {
  assert.deepEqual(findRawSlashToken("/compact", 4), {
    start: 0,
    end: 8,
    token: "/compact",
    query: "com",
  });
  assert.equal(findRawSlashToken(" /compact", 4), null);
  assert.equal(findRawSlashToken("/compact\nnext", 4), null);
  assert.equal(resolveCodexHostInputAction("/compact"), "compact");
  assert.equal(resolveCodexHostInputAction("/compact "), "compact");
  assert.equal(resolveCodexHostInputAction("/Compact"), null);
  assert.equal(resolveCodexHostInputAction("/unknown"), null);
});

test("Codex CLI registry covers public commands while excluding plan/mode/fast", () => {
  const tokens = CODEX_CLI_SLASH_COMMANDS.map((item) => item.token);
  assert.deepEqual(tokens, [
    "/model", "/ide", "/permissions", "/keymap", "/vim",
    "/setup-default-sandbox", "/sandbox-add-read-dir", "/experimental", "/approve", "/memories",
    "/skills", "/import", "/hooks", "/review", "/rename", "/new", "/archive", "/delete",
    "/resume", "/fork", "/app", "/init", "/compact", "/goal", "/agent", "/side", "/btw",
    "/copy", "/raw", "/diff", "/mention", "/status", "/usage", "/debug-config", "/title",
    "/statusline", "/theme", "/pets", "/mcp", "/apps", "/plugins", "/logout", "/quit", "/exit",
    "/feedback", "/ps", "/stop", "/clear", "/personality", "/subagents",
  ]);
  assert.equal(tokens.includes("/plan"), false);
  assert.equal(tokens.includes("/mode"), false);
  assert.equal(tokens.includes("/fast"), false);
  assert.equal(tokens.includes("/approvals"), false);
  assert.equal(tokens.includes("/collab"), false);
  assert.equal(tokens.includes("/realtime"), false);
  assert.equal(tokens.includes("/settings"), false);
  assert.deepEqual(CODEX_CLI_DEBUG_SLASH_COMMANDS.map((item) => item.token), [
    "/rollout", "/test-approval", "/debug-m-drop", "/debug-m-update",
  ]);
  const actions = buildCodexCliSlashInputActions({ hasConversationHistory: true, runningTurnId: null, queueLength: 0 });
  assert.equal(actions.length, tokens.length);
  assert.equal(actions.every((item) => item.kind === "slash" && item.webSupport === "supported"), true);
  assert.equal(actions.find((item) => item.token === "/model")?.availableDuringTask, true);
  assert.equal(actions.find((item) => item.token === "/permissions")?.availableDuringTask, true);
  assert.equal(actions.find((item) => item.token === "/new")?.supportsInlineArgs, true);
  assert.equal(actions.find((item) => item.token === "/clear")?.supportsInlineArgs, true);
  assert.equal(actions.find((item) => item.token === "/resume")?.availableDuringTask, true);
  assert.equal(actions.find((item) => item.token === "/statusline")?.availableDuringTask, true);
  assert.equal(actions.find((item) => item.token === "/personality")?.availableDuringTask, true);
  assert.equal(buildCodexCliSlashInputActions({ hasConversationHistory: true, runningTurnId: "turn-1", queueLength: 0 })
    .find((item) => item.token === "/resume")?.enabled, false);
});

test("Codex CLI registry preserves clean alias and skips runtime-disabled commands during navigation", () => {
  const actions = buildCodexCliSlashInputActions({ hasConversationHistory: true, runningTurnId: null, queueLength: 0 });
  const stop = actions.find((item) => item.kind === "slash" && item.token === "/stop");
  assert.deepEqual(stop?.kind === "slash" && stop.source === "codeflow" ? stop.aliases : undefined, ["clean"]);
  const runningActions = buildCodexCliSlashInputActions({ hasConversationHistory: true, runningTurnId: "turn-1", queueLength: 0 });
  const disabledIndex = runningActions.findIndex((item) => item.token === "/fork");
  const enabledIndex = findFirstEnabledThreadInputActionIndex(actions);
  assert.ok(enabledIndex >= 0);
  assert.equal(runningActions[disabledIndex]?.enabled, false);
  assert.notEqual(moveThreadInputActionSelection(runningActions, disabledIndex, 1), disabledIndex);
});

test("Codex CLI Slash parser canonicalizes clean and preserves supported inline args", () => {
  assert.equal(parseCodexSlashCommand("/clean")?.command, "stop");
  assert.equal(parseCodexSlashCommand("/fast"), null);
  assert.equal(parseCodexSlashCommand("/fast on"), null);
  assert.deepEqual(parseCodexSlashCommand("/review custom instructions")?.trimmedArgs, "custom instructions");
  assert.deepEqual(parseCodexSlashCommand("/new named chat")?.trimmedArgs, "named chat");
  assert.deepEqual(parseCodexSlashCommand("/clear named chat")?.trimmedArgs, "named chat");
  assert.deepEqual(parseCodexSlashCommand("/goal set a goal")?.trimmedArgs, "set a goal");
  assert.equal(parseCodexSlashCommand("/goooal")?.command, "goal");
  assert.deepEqual(parseCodexSlashCommand("/ide selection")?.trimmedArgs, "selection");
  assert.deepEqual(parseCodexSlashCommand("/keymap debug")?.trimmedArgs, "debug");
  assert.deepEqual(parseCodexSlashCommand("/mcp verbose")?.trimmedArgs, "verbose");
  assert.deepEqual(parseCodexSlashCommand("/raw on")?.trimmedArgs, "on");
  assert.deepEqual(parseCodexSlashCommand("/usage weekly")?.trimmedArgs, "weekly");
  assert.deepEqual(parseCodexSlashCommand("/pets hide")?.trimmedArgs, "hide");
  assert.equal(parseCodexSlashCommand("/pet")?.command, "pets");
  assert.deepEqual(parseCodexSlashCommand("/side context")?.trimmedArgs, "context");
  assert.deepEqual(parseCodexSlashCommand("/btw context")?.trimmedArgs, "context");
  assert.deepEqual(parseCodexSlashCommand("/sandbox-add-read-dir C:\\work")?.trimmedArgs, "C:\\work");
  assert.equal(parseCodexSlashCommand("/compact foo"), null);
  assert.equal(parseCodexSlashCommand("/model gpt"), null);
  assert.equal(parseCodexSlashCommand("/archive now"), null);
  assert.equal(parseCodexSlashCommand("/title custom"), null);
  assert.equal(parseCodexSlashCommand("/rollout"), null);
  assert.equal(parseCodexSlashCommand("/mode"), null);
  assert.equal(parseCodexSlashCommand("/plan"), null);
  assert.equal(parseCodexSlashCommand("!cmd"), null);
  assert.equal(parseCodexSlashCommand(" /status"), null);
});

test("legacy resolver uses final provider text and image presence", () => {
  assert.equal(resolveLegacyEffectiveInputKind("  /help", []), "provider-slash");
  assert.equal(resolveLegacyEffectiveInputKind("  /help", ["image"]), "message");
  assert.equal(resolveLegacyEffectiveInputKind("<chat_role_user>/help</chat_role_user>", []), "message");
});

test("Codex picker accepts middle whitespace tokens and rejects obvious non-Skills", () => {
  assert.deepEqual(findCodexSkillPickerToken("先看 $rev 后续", 7), {
    start: 3,
    end: 7,
    query: "rev",
  });
  assert.equal(findCodexSkillPickerToken("value=${HOME}", 9), null);
  assert.equal(findCodexSkillPickerToken("价格 $100", 6), null);
  assert.deepEqual(findCodexSkillPickerToken("use $1password", 13), {
    start: 4,
    end: 14,
    query: "1passwor",
  });
  assert.deepEqual(findCodexSkillPickerToken("use $1password", 14), {
    start: 4,
    end: 14,
    query: "1password",
  });
  assert.equal(findCodexSkillPickerToken("foo$bar", 7), null);
});

test("binding edit rebase shifts later tokens and drops touched tokens", () => {
  const binding = { skillId: SKILL_ID, name: "review", start: 2, end: 9 };
  assert.deepEqual(rebaseCodexSkillMentionsAfterEdit("A $review Z", "AA $review Z", [binding]), [
    { ...binding, start: 3, end: 10 },
  ]);
  assert.equal(rebaseCodexSkillMentionsAfterEdit("A $review Z", "A $revise Z", [binding]), undefined);
  assert.equal(rebaseCodexSkillMentionsAfterEdit("A $review Z", "A  Z", [binding]), undefined);
});

test("insert and trim preserve exact binding offsets", () => {
  const inserted = insertCodexSkillMention({
    text: "use $rev now",
    replaceStart: 4,
    replaceEnd: 8,
    skillId: SKILL_ID,
    name: "review",
  });
  assert.equal(inserted.text, "use $review now");
  assert.equal(inserted.caret, 11);
  assert.deepEqual(inserted.skillMentions, [{ skillId: SKILL_ID, name: "review", start: 4, end: 11 }]);

  assert.deepEqual(trimThreadTextWithSkillMentions(`  ${inserted.text}  `, [
    { skillId: SKILL_ID, name: "review", start: 6, end: 13 },
  ]), {
    text: inserted.text,
    skillMentions: [{ skillId: SKILL_ID, name: "review", start: 4, end: 11 }],
  });
});
