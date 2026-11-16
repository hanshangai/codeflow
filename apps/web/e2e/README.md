# Web 浏览器测试

从仓库根执行 `pnpm --filter @codeflowai/web exec playwright install chromium webkit`，然后执行 `pnpm --filter @codeflowai/web test:e2e`。

用例使用本地 Vite（39291）和 mock 服务（39290），覆盖公开页面、登录、个人/企业设置、充值和工作区，不连接内部环境。测试报告位于 `.tmp/playwright-report/local`，失败截图和轨迹位于 `.tmp/playwright-output/local`。

这些结果代表本地页面与协议回归；真实服务及管理控制台验收由私有工程独立维护。
