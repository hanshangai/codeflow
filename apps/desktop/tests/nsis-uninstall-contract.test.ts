import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
const builderConfig = await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");

test("NSIS program lifecycle never starts Electron registration or business maintenance", () => {
  assert.match(source, /!include "nsDialogs\.nsh"/u);
  assert.doesNotMatch(source, /StrFunc\.nsh|FUNCTION_STRING_StrStr/u);
  assert.doesNotMatch(source, /--codeflow-register-installation|--codeflow-uninstall-maintenance|--codeflow-check-installation/u);
  assert.match(source, /Function un\.D16NewRequestId[\s\S]*?Call un\.D16NewRequestId/u);
  assert.match(source, /Call un\.D16StopNativeProcesses/u);
  assert.doesNotMatch(source, /powershell\.exe|ExecWait/u);
  assert.match(source, /MessageBox MB_ICONSTOP\|MB_OK[\s\S]*?Abort/u);
  assert.doesNotMatch(source, /Stop-Process|taskkill/iu);
});

test("NSIS uninstall page explains exact retention and keeps data deletion outside program removal", () => {
  assert.match(source, /!macro customUnWelcomePage[\s\S]*?UninstPage custom/u);
  assert.doesNotMatch(source, /NSD_CreateCheckbox|d16KeepData|d16Mode/u);
  assert.match(source, /账号、设备身份、配置和业务任务原样保留/u);
  assert.match(source, /在应用内显式操作并确认清理结果/u);
  assert.match(source, /DELETE_APP_DATA_UNSUPPORTED/u);
  assert.doesNotMatch(source.match(/!macro customUnInstall[\s\S]*?!macroend/u)?.[0] ?? "", /Return/u);
});

test("assisted language contract names all required keys and wires the include", () => {
  const keys = "chooseUninstallationOptions;whichInstallationShouldBeRemoved;whichInstallationRemove;forAll;onlyForMe;loginWithAdminAccount;perUserInstall;uninstall;freshInstallForCurrent;perMachineInstall;freshInstallForAll".split(";");
  for (const key of keys) assert.match(source, new RegExp(key, "u"));
  assert.doesNotMatch(source, /assistedMessages\.yml/u);
  assert.match(builderConfig, /oneClick:\s*false/u);
  assert.match(builderConfig, /include:\s*build\/installer\.nsh/u);
});
