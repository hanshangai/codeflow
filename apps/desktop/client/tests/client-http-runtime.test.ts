import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

/** 在隔离进程模拟暂停解析器收到连接结束，避免旧库断言终止测试进程。 */
async function probePausedSocketEnd(truncated: boolean): Promise<void> {
  const source = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { once } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { Client } from 'undici';
    const payload = Buffer.alloc(64 * 1024, 97);
    const server = net.createServer(socket => {
      // 测试主动销毁 Client 时，服务端收到 reset 属于预期清理结果。
      socket.on('error', error => assert.equal(error.code, 'ECONNRESET'));
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\\r\\nConnection: close\\r\\n' +
          (${truncated} ? 'Content-Length: ' + payload.length * 2 + '\\r\\n' : '') + '\\r\\n');
        socket.write(payload);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new Client('http://127.0.0.1:' + server.address().port);
    try {
      const response = await client.request({ path: '/', method: 'GET', highWaterMark: 1 });
      const socket = client[Object.getOwnPropertySymbols(client).find(key => key.description === 'socket')];
      const parser = socket[Object.getOwnPropertySymbols(socket).find(key => key.description === 'parser')];
      for (let attempt = 0; !parser.paused && attempt < 100; attempt++) await delay(10);
      assert.equal(parser.paused, true, 'must reproduce backpressure before ending the socket');
      for (let attempt = 0; parser.bytesRead + socket.readableLength < payload.length && attempt < 100; attempt++) await delay(10);
      assert.equal(parser.bytesRead + socket.readableLength, payload.length, 'all wire bytes must arrive before EOF');
      // Windows 不稳定派发此竞态；只注入 end 事件，真实 HTTP 解析器和数据流仍负责处理。
      const bodyError = new Promise(resolve => response.body.once('error', resolve));
      socket.emit('end');
      const body = ${truncated} ? bodyError.then(error => { throw error; }) : response.body.arrayBuffer();
      const outcome = ${truncated}
        ? assert.rejects(body, error => error.code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
        : body.then(bytes => assert.equal(bytes.byteLength, payload.length));
      await outcome;
    } finally {
      await client.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url), timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.stderr, "");
}

test("HTTP parser drains a paused response on socket end without crashing Client", async () => {
  await probePausedSocketEnd(false);
});

test("HTTP parser still rejects a truncated paused response instead of reporting success", async () => {
  await probePausedSocketEnd(true);
});

test("Client native fetch uses the patched dispatcher while preserving JSON, streams and cancellation", async () => {
  const source = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { getGlobalDispatcher } from 'undici';
    const original = { fetch, Response, Request, Headers };
    await import('./src/runtime/clientHttpRuntime.ts');
    assert.deepEqual({ fetch, Response, Request, Headers }, original);
    const agent = getGlobalDispatcher();
    const dispatch = agent.dispatch.bind(agent);
    let calls = 0;
    agent.dispatch = (options, handler) => { calls++; return dispatch(options, handler); };
    const server = createServer((request, response) => {
      if (request.url === '/abort') { response.writeHead(200); response.write('partial'); return; }
      if (request.url === '/stream') { response.write('first'); response.end('second'); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      const json = await fetch(origin);
      assert.ok(json instanceof original.Response);
      assert.deepEqual(await json.json(), { ok: true });
      assert.equal(await (await fetch(origin + '/stream')).text(), 'firstsecond');
      const controller = new AbortController();
      const response = await fetch(origin + '/abort', { signal: controller.signal });
      const reason = new Error('cancel-download');
      controller.abort(reason);
      await assert.rejects(response.text(), error => error === reason);
      assert.equal(calls, 3, 'native fetch must actually route through the patched agent');
    } finally {
      await agent.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  `;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url), timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.stderr, "");
});
