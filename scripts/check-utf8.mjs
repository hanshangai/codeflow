#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".less",
  ".md",
  ".mjs",
  ".ps1",
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

const MOJIBAKE_PATTERNS = [
  { label: "replacement character", pattern: /\uFFFD/u },
  { label: "gbk mojibake marker", pattern: new RegExp("\\u951F\\u65A4\\u62F7", "u") },
  { label: "utf8 mojibake marker", pattern: new RegExp("\\u00EF\\u00BF\\u00BD", "u") },
];

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Returns explicit paths or tracked repository text files when no paths are passed. */
function resolveCandidateFiles(argv) {
  const explicitFiles = argv.map((file) => path.normalize(file)).filter(Boolean);
  if (explicitFiles.length) return explicitFiles;
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean).map((file) => path.normalize(file));
}

/** Keeps the scan focused on source-like text files instead of binaries and build artifacts. */
function isTextCandidate(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/node_modules/") || normalized.includes("/dist/")) return false;
  return TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

/** Validates one file as UTF-8 and flags common mojibake markers. */
function validateUtf8File(filePath) {
  if (!existsSync(filePath)) return [`missing file: ${filePath}`];
  if (!statSync(filePath).isFile()) return [];
  if (!isTextCandidate(filePath)) return [];

  const bytes = readFileSync(filePath);
  const issues = [];
  let text = "";
  try {
    text = utf8Decoder.decode(bytes);
  } catch (error) {
    issues.push(`invalid UTF-8: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return issues;
  }

  if (bytes.includes(0)) {
    issues.push(`contains NUL bytes, likely not UTF-8 text: ${filePath}`);
  }

  for (const { label, pattern } of MOJIBAKE_PATTERNS) {
    if (pattern.test(text)) issues.push(`suspicious ${label}: ${filePath}`);
  }
  return issues;
}

/** Runs the repository UTF-8 guard and exits non-zero on the first detected issue set. */
function main() {
  const files = resolveCandidateFiles(process.argv.slice(2));
  const issues = files.flatMap(validateUtf8File);
  if (issues.length) {
    console.error(["UTF-8 check failed:", ...issues.map((issue) => `- ${issue}`)].join("\n"));
    process.exitCode = 1;
  }
}

main();
