import test from "node:test";
import assert from "node:assert/strict";

import {
  collectClipboardFileReferenceUrls,
  resolveOversizedFileReferenceUrl,
} from "../src/features/composer/oversized-file-reference.ts";

/** 构造最小剪贴板对象，覆盖 DataTransfer.getData 行为。 */
function clipboardData(values: Record<string, string>): Pick<DataTransfer, "getData"> {
  return {
    getData(type: string): string {
      return values[type] ?? "";
    },
  };
}

test("collectClipboardFileReferenceUrls converts Windows paths to file URLs", () => {
  const urls = collectClipboardFileReferenceUrls(clipboardData({
    "text/plain": "\"Z:\\code\\aidt-code\\large file.log\"",
  }));

  assert.deepEqual(urls, ["file:///Z:/code/aidt-code/large%20file.log"]);
});

test("collectClipboardFileReferenceUrls keeps uri-list entries and ignores comments", () => {
  const urls = collectClipboardFileReferenceUrls(clipboardData({
    "text/uri-list": "# copied file\r\nfile:///Z:/code/aidt-code/a.log\r\n",
  }));

  assert.deepEqual(urls, ["file:///Z:/code/aidt-code/a.log"]);
});

test("collectClipboardFileReferenceUrls encodes spaces in file URLs", () => {
  const urls = collectClipboardFileReferenceUrls(clipboardData({
    "text/uri-list": "file:///Z:/code/aidt-code/large file.log",
  }));

  assert.deepEqual(urls, ["file:///Z:/code/aidt-code/large%20file.log"]);
});

test("resolveOversizedFileReferenceUrl prefers file object path when available", () => {
  const file = { name: "a.log", path: "Z:\\code\\aidt-code\\a.log" } as unknown as File;

  assert.equal(resolveOversizedFileReferenceUrl(file, ["file:///Z:/code/aidt-code/other.log"], 0), "file:///Z:/code/aidt-code/a.log");
});

test("resolveOversizedFileReferenceUrl falls back to clipboard URL by index", () => {
  const file = { name: "large.log" } as File;

  assert.equal(resolveOversizedFileReferenceUrl(file, ["file:///Z:/code/aidt-code/large.log"], 0), "file:///Z:/code/aidt-code/large.log");
});

test("resolveOversizedFileReferenceUrl returns null when browser exposes no path", () => {
  const file = { name: "large.log" } as File;

  assert.equal(resolveOversizedFileReferenceUrl(file, [], 0), null);
});
