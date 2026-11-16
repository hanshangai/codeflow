import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisplayedClients,
  findReconnectedClientId,
} from "../../apps/web/src/features/settings/client-management-state.js";

type Client = { clientId: string; version: string };

test("Client 重启离线时保留升级进度卡片", () => {
  const snapshot = { clientId: "client-a", version: "1.0.0" };
  assert.deepEqual(buildDisplayedClients<Client>([], { "client-a": snapshot }, { "client-a": "restarting" }), [snapshot]);
});

test("在线 Client 优先于旧快照且空闲快照不展示", () => {
  const online = { clientId: "client-a", version: "2.0.0" };
  const stale = { clientId: "client-a", version: "1.0.0" };
  const idle = { clientId: "client-b", version: "1.0.0" };
  assert.deepEqual(buildDisplayedClients<Client>(
    [online],
    { "client-a": stale, "client-b": idle },
    { "client-a": "success", "client-b": "idle" },
  ), [online]);
});

const compareVersion = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true });

test("重连判定优先匹配原 Client ID", () => {
  assert.equal(findReconnectedClientId(
    "client-a",
    "device-a",
    "2.0.0",
    [{ clientId: "client-a", deviceId: "device-a", version: "2.0.0" }],
    compareVersion,
  ), "client-a");
  assert.equal(findReconnectedClientId(
    "client-a",
    "device-a",
    "2.0.0",
    [{ clientId: "client-a", deviceId: "device-other", version: "2.0.0" }],
    compareVersion,
  ), null);
});

test("新 Client ID 必须匹配原设备标识", () => {
  const existingLatest = { clientId: "client-existing", deviceId: "device-other", version: "2.0.0" };
  const replacement = { clientId: "client-new", deviceId: "device-old", version: "2.0.0" };
  assert.equal(findReconnectedClientId(
    "client-old",
    "device-old",
    "2.0.0",
    [existingLatest, replacement],
    compareVersion,
  ), "client-new");
  assert.equal(findReconnectedClientId(
    "client-old",
    "device-old",
    "2.0.0",
    [existingLatest],
    compareVersion,
  ), null);
});

test("缺少设备标识或多个设备候选时不猜测重连归属", () => {
  assert.equal(findReconnectedClientId(
    "client-old",
    null,
    "2.0.0",
    [{ clientId: "client-new", deviceId: "device-old", version: "2.0.0" }],
    compareVersion,
  ), null);
  assert.equal(findReconnectedClientId(
    "client-old",
    "device-old",
    "2.0.0",
    [
      { clientId: "client-new-a", deviceId: "device-old", version: "2.0.0" },
      { clientId: "client-new-b", deviceId: "device-old", version: "2.0.0" },
    ],
    compareVersion,
  ), null);
});
