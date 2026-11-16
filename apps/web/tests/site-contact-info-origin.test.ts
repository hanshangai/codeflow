import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { wsOriginToHttpOrigin } from "../src/api/request.ts";

type PageLocation = Pick<Location, "protocol" | "hostname" | "port" | "origin">;
type Candidate = { url: string; timeoutMs: number };
const source = readFileSync(new URL("../src/composables/siteContactInfo.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("siteContactInfo.ts", source, ts.ScriptTarget.Latest, true);
const builder = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildPublicContactInfoCandidates");
assert.ok(builder, "必须执行现有private候选builder");
const constants = ast.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
  ts.isIdentifier(declaration.name) && ["PUBLIC_CONTACT_INFO_TIMEOUT_MS", "PUBLIC_CONTACT_INFO_PROBE_TIMEOUT_MS"].includes(declaration.name.text)));
const compiled = ts.transpileModule([...constants, builder].map(node => node.getText(ast)).join("\n") + "\nbuildPublicContactInfoCandidates;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

/** 执行真实private builder与原WS转换；只隔离window，不发请求或复制候选算法。 */
function candidates(serverWsOrigin: string, location?: PageLocation): Candidate[] {
  const build = vm.runInNewContext(compiled, { wsOriginToHttpOrigin, ...(location ? { window: { location } } : {}) }) as
    (ctx: { serverWsOrigin: string }) => Candidate[];
  return JSON.parse(JSON.stringify(build({ serverWsOrigin }))) as Candidate[];
}

for (const location of [
  { protocol: "codeflow:", hostname: "desktop", port: "", origin: "codeflow://desktop" },
  { protocol: "file:", hostname: "", port: "", origin: "null" },
  { protocol: "data:", hostname: "", port: "", origin: "null" },
  { protocol: "about:", hostname: "", port: "", origin: "null" },
]) {
  test(`${location.protocol}页面不加入公共联系方式同源候选`, () => {
    assert.deepEqual(candidates("", location), []);
    assert.deepEqual(candidates("wss://api.example.test", location), [{ url: "https://api.example.test/api/public/contact-info", timeoutMs: 5000 }]);
  });
}

for (const protocol of ["http:", "https:"]) {
  test(`${protocol}浏览器保配置优先和同源探测顺序`, () => {
    const origin = `${protocol}//site.example.test`;
    assert.deepEqual(candidates("wss://api.example.test", { protocol, hostname: "site.example.test", port: "", origin }), [
      { url: "https://api.example.test/api/public/contact-info", timeoutMs: 5000 },
      { url: origin + "/api/public/contact-info", timeoutMs: 800 },
    ]);
  });

  test(`${protocol}39281开发页保39280优先与页面探测`, () => {
    assert.deepEqual(candidates("", { protocol, hostname: "localhost", port: "39281", origin: `${protocol}//localhost:39281` }), [
      { url: `${protocol}//localhost:39280/api/public/contact-info`, timeoutMs: 5000 },
      { url: `${protocol}//localhost:39281/api/public/contact-info`, timeoutMs: 800 },
    ]);
  });
}

test("配置源与页面同源去重并保原完整超时", () => {
  assert.deepEqual(candidates("wss://site.example.test/", { protocol: "https:", hostname: "site.example.test", port: "", origin: "https://site.example.test" }), [
    { url: "https://site.example.test/api/public/contact-info", timeoutMs: 5000 },
  ]);
});

test("开发配置源与39280去重且不改变首项顺序", () => {
  assert.deepEqual(candidates("ws://localhost:39280", { protocol: "http:", hostname: "localhost", port: "39281", origin: "http://localhost:39281" }), [
    { url: "http://localhost:39280/api/public/contact-info", timeoutMs: 5000 },
    { url: "http://localhost:39281/api/public/contact-info", timeoutMs: 800 },
  ]);
});

test("开发页配置第三方源时保配置、39280、同源三个候选顺序", () => {
  assert.deepEqual(candidates("wss://api.example.test", { protocol: "http:", hostname: "localhost", port: "39281", origin: "http://localhost:39281" }), [
    { url: "https://api.example.test/api/public/contact-info", timeoutMs: 5000 },
    { url: "http://localhost:39280/api/public/contact-info", timeoutMs: 5000 },
    { url: "http://localhost:39281/api/public/contact-info", timeoutMs: 800 },
  ]);
});

test("空页面来源不新增候选，非浏览器仍保配置源", () => {
  assert.deepEqual(candidates("", { protocol: "http:", hostname: "", port: "", origin: "" }), []);
  assert.deepEqual(candidates("ws://api.example.test"), [{ url: "http://api.example.test/api/public/contact-info", timeoutMs: 5000 }]);
});
