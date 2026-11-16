import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";

const accountDrawerSource = readFileSync(new URL("../src/features/account/components/account-drawer.vue", import.meta.url), "utf8");
const enterpriseDrawerSource = readFileSync(new URL("../src/features/account/components/enterprise-drawer.vue", import.meta.url), "utf8");
const modalsSource = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
const accountStoreSource = readFileSync(new URL("../src/store/account.ts", import.meta.url), "utf8");
const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

/** 运行真实分区条件和身份派生，仅省去与资料可见性无关的表单内容。 */
function visibleAccountSections(surface: "default" | "h5", identityType: string | null): string[] {
  const descriptor = parse(accountDrawerSource).descriptor;
  const script = ts.createSourceFile("account-drawer.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
  const context: Record<string, unknown> = { CANCEL_COPY: { action: "注销账号" } };
  for (const name of ["isH5Surface", "isEnterpriseAdminIdentity"]) {
    const initializer = declarations.find(declaration => declaration.name.getText(script) === name)?.initializer;
    assert.ok(initializer, `${name}必须由账号抽屉派生`);
    context[name] = new Function("computed", "props", "accessContext", `return ${initializer.getText(script)}`)(
      vue.computed, { surface }, vue.ref(identityType ? { identityType } : null),
    );
  }
  const sections: string[] = [];
  /** 保留分区原始条件与标题，验证身份边界而不绑定旧页签结构。 */
  const visit = (node: any): void => {
    if (node.tag === "section") {
      const header = node.children.find((child: any) => child.tag === "header");
      const heading = header?.children.find((child: any) => child.tag === "div")?.children.find((child: any) => child.tag === "strong");
      if (heading && ["个人资料", "修改密码", "企业信息"].some(title => heading.loc.source.includes(title))) {
        sections.push(`${node.loc.source.slice(0, node.loc.source.indexOf(">") + 1)}${heading.loc.source}</section>`);
      }
      // 注销入口已改为操作按钮，仍使用所属分区的真实显示条件验证身份边界。
      if (node.loc.source.includes('ref="cancelSectionRef"') && node.loc.source.includes("CANCEL_COPY.action")) {
        sections.push(`${node.loc.source.slice(0, node.loc.source.indexOf(">") + 1)}<strong>{{ CANCEL_COPY.action }}</strong></section>`);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(descriptor.template!.ast);
  const compiled = compileTemplate({ source: `<div>${sections.join("")}</div>`, filename: "account-drawer.vue", id: "account-sections",
    compilerOptions: { mode: "function", prefixIdentifiers: true, isCustomElement: () => true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)(vue) as (context: object, cache: unknown[]) => vue.VNode;
  const tree = render(vue.proxyRefs(context), []);
  return (tree.children as vue.VNode[]).filter(node => vue.isVNode(node) && node.type === "section")
    .map(node => String((node.children as vue.VNode[])[0]!.children));
}

test("account page exposes enterprise profile only for desktop enterprise admins", () => {
  assert.deepEqual(visibleAccountSections("default", "ENTERPRISE_ADMIN"), ["个人资料", "修改密码", "企业信息", "注销账号"]);
  for (const identity of [null, "PERSONAL_USER", "ENTERPRISE_MEMBER", "SUPER_ADMIN"]) {
    assert.deepEqual(visibleAccountSections("default", identity), ["个人资料", "修改密码", "注销账号"]);
  }
  for (const identity of [null, "PERSONAL_USER", "ENTERPRISE_MEMBER", "ENTERPRISE_ADMIN", "SUPER_ADMIN"]) {
    assert.deepEqual(visibleAccountSections("h5", identity), ["个人资料", "修改密码"]);
  }
  assert.match(accountDrawerSource, /@click="saveEnterpriseProfile"/u);
  assert.match(modalsSource, /<AccountDrawer[\s\S]*@save-enterprise="handleSaveEnterprise"/u);
  assert.match(accountStoreSource, /this\.meSummary\?\.enterpriseSummary\?\.enterpriseId === result\.enterpriseId[\s\S]*enterpriseSummary: result/u);
});

test("account overview shows enterprise token balance by identity scope", () => {
  assert.match(accountDrawerSource, /getEnterpriseRelayBalancePool/u);
  assert.match(accountDrawerSource, /isEnterpriseAdminIdentity\.value[\s\S]*getEnterpriseRelayBalancePool/u);
  assert.match(accountDrawerSource, /parseRelayUsdUnits\(enterprisePoolResult\.availableUsdUnits\)[\s\S]*parseRelayUsdUnits\(enterprisePoolResult\.allocatedAvailableUsdUnits\)/u);
  assert.match(accountDrawerSource, /balancesResult\.enterprise\?\.remainingUsdUnits \?\? "0"/u);
  assert.match(accountDrawerSource, /v-if="isEnterpriseIdentity"[\s\S]*企业Token余额[\s\S]*enterpriseTokenBalanceDisplayText/u);
  assert.match(accountDrawerSource, /个人Token余额[\s\S]*tokenBalanceText/u);
});

test("enterprise profile is no longer exposed from enterprise management", () => {
  assert.doesNotMatch(enterpriseDrawerSource, /key="profile" tab="企业资料"/u);
  assert.doesNotMatch(enterpriseDrawerSource, /save-enterprise|savingProfile/u);
});

test("enterprise drawer drops the retired benefits overview", () => {
  assert.doesNotMatch(enterpriseDrawerSource, /企业权益|PackageAllocationHistory|套餐分配/u);
  assert.doesNotMatch(enterpriseDrawerSource, /summary.entitlement|开通时间|开通来源/u);
  assert.doesNotMatch(enterpriseDrawerSource, /套餐续费|availablePersonMonths|openAdjust|PackageAdjustModal|autoRenewEnabled|adjustPersonMonths/u);
});

test("member management exposes a focused add action", () => {
  assert.match(enterpriseDrawerSource, /enterprise-drawer__member-toolbar[\s\S]*<UserAddOutlined \/>[\s\S]*添加成员/u);
  assert.doesNotMatch(enterpriseDrawerSource, /添加企业成员/u);
});
