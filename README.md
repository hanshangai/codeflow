# CodeFlow

CodeFlow 桌面端、内置 Client、官网和用户/企业 Web，采用 Apache-2.0。

需要 Node.js 22.16.0+（22.x）或24.x，以及 pnpm 10.14.0。包含 npm 12.2.2 的桌面资源构建需要 Node.js 22.22.2+ 或24.15.0+。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm dev:web
```

`pnpm dev:client` 启动本地 Client，`pnpm dev:desktop` 启动桌面壳。用户 Web 及桌面功能需要连接可用的云服务；本地工作区能力由 Client 提供。开发配置参考 env/.env.example。

测试使用 `pnpm test`；Web 本地浏览器测试使用 `pnpm --filter @codeflowai/web test:e2e`。首次运行需安装相应 Playwright 浏览器。

桌面本地计划、资源构建和校验入口为 `pnpm release:desktop`。需要签名的开发测试使用独立测试密钥及测试信任文件，不关闭验签。社区构建不会获得官方升级或服务发布权限。Server 与管理控制台独立维护，不包含于本仓库。
