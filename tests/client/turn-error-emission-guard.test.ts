import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const CLIENT_SRC_ROOT = fileURLToPath(new URL("../../apps/desktop/client/src/", import.meta.url));

test("apps/desktop/client turn.error emissions must go through shared turn-error helper", () => {
  const offenders: string[] = [];

  for (const filePath of walkTsFiles(CLIENT_SRC_ROOT)) {
    const content = fs.readFileSync(filePath, "utf8");
    if (!containsRawTurnErrorLiteral(content, filePath)) continue;
    offenders.push(path.relative(CLIENT_SRC_ROOT, filePath).replace(/\\/g, "/"));
  }

  assert.deepEqual(offenders, []);
});

function walkTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fullPath.endsWith(".ts")) continue;
    files.push(fullPath);
  }
  return files;
}

function containsRawTurnErrorLiteral(content: string, filePath: string): boolean {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isObjectLiteralExpression(node)) {
      const typeProperty = node.properties.find((property) =>
        ts.isPropertyAssignment(property)
        && property.name.getText(sourceFile) === "type"
        && ts.isStringLiteral(property.initializer)
        && property.initializer.text === "turn.error",
      );
      if (typeProperty) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}
