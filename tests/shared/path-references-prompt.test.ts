import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspacePathReference,
  parseWorkspacePathMentions,
} from "../../packages/shared/src/index.ts";
import { buildPromptText } from "../../apps/desktop/client/src/app/utils/promptWithAttachments.ts";

test("buildPromptText appends path references without inlining file content", () => {
  const prompt = buildPromptText({
    text: "请看这些路径",
    files: [],
    pathReferences: [
      createWorkspacePathReference({ path: "apps/web/src/store/chat.ts", kind: "file" }),
      createWorkspacePathReference({ path: "apps/web/src/features/composer", kind: "directory" }),
    ],
  });

  assert.match(prompt, /\[工作区路径引用\]/);
  assert.match(prompt, /@apps\/web\/src\/store\/chat\.ts \(file\)/);
  assert.match(prompt, /@apps\/web\/src\/features\/composer \(directory\)/);
  assert.doesNotMatch(prompt, /export const|<script|function ChatComposer/);
});

test("parseWorkspacePathMentions supports quoted paths and CJK inline mentions", () => {
  const mentions = parseWorkspacePathMentions('请看@apps/web/src/store/chat.ts 和 @"docs/My File.md"#L10');

  assert.deepEqual(
    mentions.map((mention) => ({
      path: mention.path,
      quoted: mention.quoted,
      lineSuffix: mention.lineSuffix,
    })),
    [
      { path: "apps/web/src/store/chat.ts", quoted: false, lineSuffix: null },
      { path: "docs/My File.md", quoted: true, lineSuffix: "#L10" },
    ],
  );
});

test("parseWorkspacePathMentions ignores email-like ascii boundaries", () => {
  const mentions = parseWorkspacePathMentions("mail dev@example.com，再看 @README.md");

  assert.deepEqual(mentions.map((mention) => mention.path), ["README.md"]);
});
