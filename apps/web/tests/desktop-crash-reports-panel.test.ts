import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";

import { resolveAllowedSystemPanels, resolveAvailableSystemPanels } from "../src/features/admin/systemPanelAccess";

test("crash report management stays outside public menus", () => { for (const scope of ["super_admin", "enterprise_admin", "enterprise_member", "personal_user"] as const) { assert.equal(resolveAllowedSystemPanels(scope).includes("desktop-crash-reports"), false); assert.equal(resolveAvailableSystemPanels(scope).some(panel => panel.key === "desktop-crash-reports"), false); } });
