import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
const builderConfig = await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");

test("NSIS hooks keep installation registration and synchronous maintenance boundaries", () => {
  assert.match(source, /!include "nsDialogs\.nsh"/u);
  assert.doesNotMatch(source, /StrFunc\.nsh|FUNCTION_STRING_StrStr/u);
  assert.match(source, /!macro customInstall[\s\S]*?--codeflow-register-installation[\s\S]*?!macroend/u);
  assert.match(source, /!macro customUnInstall[\s\S]*?--codeflow-uninstall-maintenance[\s\S]*?!macroend/u);
  assert.match(source, /Function un\.D16NewRequestId[\s\S]*?Call un\.D16NewRequestId/u);
  assert.match(source, /ExecWait .*--codeflow-uninstall-maintenance/u);
  assert.match(source, /MessageBox MB_ICONSTOP\|MB_OK[\s\S]*?Abort/u);
  assert.doesNotMatch(source, /Stop-Process|taskkill/iu);
});

test("NSIS hooks retain the choice page and finite maintenance mode", () => {
  assert.match(source, /!macro customUnWelcomePage[\s\S]*?UninstPage custom[\s\S]*?NSD_Check/u);
  assert.match(source, /!macro customUnInstall[\s\S]*?\$\{IfNot\} \$\{isUpdated\}[\s\S]*?\$d16Mode/u);
  assert.doesNotMatch(source.match(/!macro customUnInstall[\s\S]*?!macroend/u)?.[0] ?? "", /Return/u);
});

test("assisted language contract names all required keys and wires the include", () => {
  const keys = "chooseUninstallationOptions;whichInstallationShouldBeRemoved;whichInstallationRemove;forAll;onlyForMe;loginWithAdminAccount;perUserInstall;uninstall;freshInstallForCurrent;perMachineInstall;freshInstallForAll".split(";");
  for (const key of keys) assert.match(source, new RegExp(key, "u"));
  assert.doesNotMatch(source, /assistedMessages\.yml/u);
  assert.match(builderConfig, /oneClick:\s*false/u);
  assert.match(builderConfig, /include:\s*build\/installer\.nsh/u);
});
