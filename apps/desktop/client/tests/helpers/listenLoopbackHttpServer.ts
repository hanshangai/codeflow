import type { Server } from "node:http";

// 当前 Node 内置 Undici 的 Fetch bad-port 表；只有明确命中才重新分配。
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** 真实绑定后排除 Fetch 禁止端口；至多重新分配八次，监听或关闭失败立即抛出。 */
export async function listenLoopbackHttpServer(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.removeListener("listening", onListening); reject(error); };
      const onListening = (): void => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListening); server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_LOOPBACK_ADDRESS_INVALID");
    if (!BAD_PORTS.has(address.port)) return address.port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error("TEST_FETCH_SAFE_PORT_EXHAUSTED");
}
