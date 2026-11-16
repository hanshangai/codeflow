import assert from "node:assert/strict";
import test from "node:test";
import { describeUserFacingError } from "../src/utils/userErrorMessage.ts";
import { toUpdateDiagnosticCause, toShellUpdateDiagnosticCause } from "../src/desktopUpdateFailure.ts";

test("证书、网络、磁盘及运行时错误以描述展示，保留原异常", () => {
  for (const [code, expected] of [["UNABLE_TO_VERIFY_LEAF_SIGNATURE", /证书/], ["ENOTFOUND", /域名/],
    ["ENOSPC", /磁盘空间/], ["CLIENT_READY_TIMEOUT", /本机运行环境/], ["DESKTOP_UPDATE_TRANSPORT_FAILED", /更新服务器/]] as const) {
    const error = Object.assign(new Error(code), { code, requestId: "request" });
    assert.match(describeUserFacingError(error), expected);
    assert.ok(!describeUserFacingError(error).includes(code));
    assert.equal(error.message, code);
    assert.equal(error.requestId, "request");
  }
});

test("桌面云关联和设备认证使用固定中文描述，不展示内部错误码或私密原因", () => {
  for (const [code, text] of [["DESKTOP_DEVICE_AUTH_INVALID", /设备认证/], ["DESKTOP_DEVICE_REVOKED", /已撤销/],
    ["DESKTOP_CLOUD_TRANSPORT_FAILED", /账号服务器/], ["DESKTOP_CLOUD_ACCOUNT_FAILED", /关联/]] as const) {
    const message = describeUserFacingError(Object.assign(new Error("private token"), { code }));
    assert.match(message, text);
    assert.doesNotMatch(message, /DESKTOP_|private|token/);
  }
});

test("未知代码和聚合错误不直接回显，已有业务描述仍保留", () => {
  assert.equal(describeUserFacingError(new Error("UNKNOWN_FIXTURE_ERROR"), "本次操作失败"), "本次操作失败");
  assert.equal(describeUserFacingError({ code: "BAD_REQUEST", message: "请填写工作区名称" }, undefined, true), "请填写工作区名称");
  assert.equal(describeUserFacingError({ code: "CLIENT_ERROR", message: "diff failed" }, undefined, true), "diff failed");
  assert.equal(describeUserFacingError(new Error("private token C:/secret"), "更新失败"), "更新失败");
  const error = new AggregateError([new Error("DESKTOP_UPDATE_TRANSPORT_FAILED"), new Error("DESKTOP_ERROR_LOG_FAILED")], "AGGREGATE_ERROR");
  assert.match(describeUserFacingError(error), /更新服务器[\s\S]*日志保存失败/);
  assert.doesNotMatch(describeUserFacingError(error), /DESKTOP_|AGGREGATE/);
});

test("诊断原因树和 IPC 包装消息使用相同描述，循环和getter不影响展示", () => {
  assert.match(describeUserFacingError({ code: "DESKTOP_UPDATE_TRANSPORT_FAILED", causes: [{ code: "CERT_HAS_EXPIRED" }] }), /证书已过期/);
  assert.match(describeUserFacingError(new Error("Error invoking remote method 'check': Error: DESKTOP_UPDATE_TRANSPORT_FAILED")), /更新服务器/);
  const error: any = { code: "ENOSPC", get message() { throw new Error("getter must not execute"); } };
  error.cause = error;
  assert.match(describeUserFacingError(error), /磁盘空间/);
});

test("真实更新诊断脱敏后仍能解释证书、域名和连接超时原因", () => {
  for (const [code, expected] of [["UNABLE_TO_VERIFY_LEAF_SIGNATURE", /证书/], ["ENOTFOUND", /域名/],
    ["UND_ERR_CONNECT_TIMEOUT", /超时/]] as const) {
    const cause = Object.assign(new Error("sensitive response body"), { code });
    const error = Object.assign(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause }), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED" });
    for (const serialize of [toUpdateDiagnosticCause, toShellUpdateDiagnosticCause]) {
      const diagnostic = serialize(error);
      assert.match(describeUserFacingError(diagnostic), expected);
      assert.doesNotMatch(JSON.stringify(diagnostic), /sensitive/);
      assert.doesNotMatch(describeUserFacingError(diagnostic), /DESKTOP_|UND_ERR_|UNABLE_TO_VERIFY|ENOTFOUND/);
    }
  }
});
