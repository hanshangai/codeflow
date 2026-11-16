import assert from "node:assert/strict";
import test from "node:test";

import type { AccountPermissionInput } from "../src/types/account.ts";
import { canExportBuiltinSpecRole, canMaintainBuiltinSpecAssets } from "../src/utils/accountRoleAccess.ts";

const superAdmin: AccountPermissionInput = { accountRole: "super_admin" };

test("builtin assets are read-only for every role", () => {
  assert.equal(canMaintainBuiltinSpecAssets(superAdmin), false);
});

test("super admin can still export builtin assets", () => {
  assert.equal(canExportBuiltinSpecRole(superAdmin), true);
});
