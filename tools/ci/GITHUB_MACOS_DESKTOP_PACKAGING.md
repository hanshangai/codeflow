# 用 GitHub Actions 构建并验收 macOS 桌面安装包

这份说明以 CodeFlow 已跑通的 arm64/x64 流水线为例，供其他桌面项目移植。GitHub Actions 负责在真实 macOS runner 上构建、安装和验收；项目仍需提供自己的打包命令及安装后检查逻辑。

## 流水线做什么

每个架构使用一台原生 runner，避免用交叉编译猜测 Electron 或其他原生模块是否可运行：

| 芯片 | GitHub-hosted runner | `process.arch` |
| --- | --- | --- |
| Apple 芯片 | `macos-15` | `arm64` |
| Intel 芯片 | `macos-15-intel` | `x64` |

每个任务依次安装锁定版本的 Node/pnpm 依赖，执行平台和项目测试，构建 DMG，在隔离目录挂载并安装 `.app`，启动两次检查本地数据能否跨重启保存，最后上传安装包和验收报告。

本例生成未公证、ad-hoc 签名的 DMG。它用于构建和安装验证，不包含 Developer ID 签名、公证、官网上传或自动更新发布。

## 仓库准备

1. 将桌面项目推到 GitHub，确认根目录提交了 lockfile、桌面构建配置及 CI 脚本。使用 pnpm 的仓库应提交 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。
2. 先在本机完成对应架构的桌面构建，确认应用能从安装后的目录启动。CI 不应拿开发服务器或 `electron .` 代替安装包验收。
3. 在仓库根目录增加 `.github/workflows/desktop-macos.yml`，并提交到默认分支。`workflow_dispatch` 工作流文件需要先存在于默认分支，之后才能从 GitHub 页面选择目标分支运行。
4. 在 GitHub 打开 **Settings → Actions → General**，允许仓库运行 Actions，并确认组织策略没有禁止 Actions。保存后在 **Actions** 页面检查目标 workflow 为启用状态。Fork 仓库可能需要所有者首次手动启用。
5. 使用 GitHub-hosted macOS runner 需要仓库套餐/组织策略允许相应 runner 和用量。`macos-15`、`macos-15-intel` 是本次验证使用的标签；创建项目时应确认 GitHub 当前仍提供这些 runner。

普通构建只需要 workflow 的 `contents: read` 权限。仅上传 Actions artifact 时不用配置 Apple Developer 凭据，也不要为了打包给 workflow 写入仓库内容的权限。

## 最小工作流骨架

下面示例负责架构矩阵、依赖安装和 artifact 上传。复制后把标注的**项目构建命令**与**安装验收命令**替换为仓库实际脚本；两者不能由通用 YAML 自动推断。

```yaml
name: macOS desktop package

on:
  workflow_dispatch:
  # 可选：需要 tag 自动构建时再启用。
  # push:
  #   tags: ["desktop-v*"]

permissions:
  contents: read

jobs:
  package:
    name: macos-${{ matrix.arch }}
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 45
    strategy:
      fail-fast: false
      matrix:
        include:
          - runner: macos-15
            arch: arm64
          - runner: macos-15-intel
            arch: x64

    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: "22.23.2" # 改为项目锁定并验证过的 Node 版本

      - uses: pnpm/action-setup@v4
        with:
          version: "10.14.0" # 改为 package.json 声明的 pnpm 版本

      - run: pnpm install --frozen-lockfile

      - name: Check native architecture
        env:
          EXPECTED_ARCH: ${{ matrix.arch }}
        run: node -e "if(process.platform!=='darwin'||process.arch!==process.env.EXPECTED_ARCH)throw Error('MACOS_RUNNER_ARCH_MISMATCH')"

      - name: Build desktop installer
        id: build
        run: |
          mkdir -p "$RUNNER_TEMP/desktop-package"
          # 替换为项目的命令；应输出 DMG 及唯一、可验证的构建元数据。
          pnpm package:mac -- "$RUNNER_TEMP/desktop-package/installers"

      - name: Install and verify packaged app
        id: verify
        run: |
          # 替换为项目的验收程序：挂载 DMG、隔离安装、启动应用并验证持久化。
          node tools/ci/verify-desktop-install.mjs \
            "$RUNNER_TEMP/desktop-package" \
            "$RUNNER_TEMP/desktop-verification"

      - name: Upload installer
        if: ${{ always() && steps.build.outcome == 'success' }}
        uses: actions/upload-artifact@v4
        with:
          name: desktop-macos-${{ matrix.arch }}
          path: |
            ${{ runner.temp }}/desktop-package/installers/*.dmg
            ${{ runner.temp }}/desktop-package/build.json
            ${{ runner.temp }}/desktop-package/SHA256SUMS
          if-no-files-found: error
          retention-days: 14

      - name: Upload installation evidence
        if: ${{ always() && steps.verify.outcome != 'skipped' }}
        uses: actions/upload-artifact@v4
        with:
          name: desktop-verification-${{ matrix.arch }}
          path: ${{ runner.temp }}/desktop-verification/report/
          if-no-files-found: error
          retention-days: 14
```

如果项目不是 pnpm，把安装步骤替换成锁文件对应的 `npm ci` 或 `yarn install --immutable`，并移除 `pnpm/action-setup`。不要删除 lockfile 校验。

## 项目需要提供的构建和验收入口

**构建脚本**应在当前 runner 架构上完成应用打包，输出到本次 run 的新目录。建议失败立即退出，并生成：

- `installers/<唯一名称>.dmg`
- `build.json`：来源 commit、版本、架构、DMG 文件名、文件大小和 SHA256
- `SHA256SUMS`

构建目录不要复用 runner 上一次构建留下的文件，否则上传时可能把旧包误认作新产物。若 arm64 和 x64 必须使用完全相同的版本号，应在工作流开始时计算一次并传给两个矩阵任务；不要在每个 runner 的午夜边界各自取日期。

**安装验收脚本**应读取 `build.json` 并复核架构、大小、SHA256；将 DMG 挂载到临时目录，把 `.app` 复制到本次 run 的隔离位置；验证 app bundle 和签名结构；用桌面自动化真实启动应用，执行一项本地读写，再关闭并第二次启动验证数据持久化。临时环境、安装目录和用户数据应留在 `$RUNNER_TEMP`，不能碰 runner 上的真实用户配置。

对于迁移、数据库升级等关键功能，把现有的迁移集成测试放入 `Install and verify` 之前。若测试依赖构建生成的 Worker 或 bundle，则先 build，再运行测试；测试应覆盖成功迁移、损坏数据失败及不发布半成品。

## CodeFlow 对应命令

本仓库实现了上面两个项目入口，可以作为移植时的完整参考：

```bash
bash tools/ci/build-macos-dmg.sh "$RUNNER_TEMP/desktop-package/installers"
node --conditions=development --import tsx --test --test-concurrency=1 \
  apps/desktop/client/tests/legacy-client-migration.test.ts \
  apps/desktop/tests/legacy-client-migration.test.ts
node tools/ci/verify-desktop-install.mjs \
  "$RUNNER_TEMP/desktop-package" \
  "$RUNNER_TEMP/desktop-verification"
```

构建命令会编译 Shared、Client、Desktop 和 Web，装配生产 Client 与 npm runtime，创建资源完整性证明，再由 `package-local-mac.mjs` 生成 DMG 并记录 SHA256。验收命令实际挂载 DMG、复制 `.app`、运行 `codesign --verify`，再用 Playwright 启动桌面应用两次并检查工作区数据保留。

CodeFlow 的工作流定义位于 `.github/workflows/desktop-dmg.yml`。这些命令引用 CodeFlow 自己的目录和桌面 API，其他项目不能只复制 YAML 就期望它们直接运行；要复用该设计，需实现本项目等价的 build 和 verify 入口，并调整项目专属测试。

## 手动运行与取回安装包

1. 推送包含 workflow 的分支。首次使用时，先在 GitHub 确认 Actions 和 workflow 均已启用。
2. 打开仓库 **Actions → Desktop macOS DMG and installation → Run workflow**，选择要构建的分支后启动。
3. 等待 `macos-arm64` 与 `macos-x64` 两项都完成。进入 run 页面下方 Artifacts，下载对应架构的 installer artifact；安装验收日志和截图在同架构的 verification artifact。
4. 下载后按 `SHA256SUMS` 校验文件摘要。只有 build 成功且 SHA256 匹配时，才把该文件视为本次 run 的安装包。

下载的是 GitHub Actions 临时工件，不会自动发布到官网。需要对外发布、公证或签名时，应另建独立发布流程，明确配置证书、notarization secrets、权限、审核和回滚步骤；不要把它混入普通 CI 打包任务。

## 常见问题

- **`Actions has been disabled for this repository`**：到 **Settings → Actions → General** 检查仓库总开关及组织策略，再确认目标 workflow 启用；Fork 可能需要仓库所有者解除首次运行限制。两处都开启后仍收到 422 时，检查组织/企业策略并查看 run 页面，不能只凭 workflow 文件存在就判断可运行。
- **`MACOS_RUNNER_ARCH_MISMATCH`**：矩阵 runner 与 `EXPECTED_ARCH` 不匹配。保留原生架构检查，并按 GitHub 当前提供的 runner 标签修正矩阵。
- **两个架构的版本不一致**：版本在每台 runner 上分别生成，可能跨 UTC 日期。改为在 workflow 级生成并传给所有架构任务。
- **验收能打开开发应用，但无法安装 DMG**：验收命令必须指向构建产物中的 `.app`，并在隔离目录实际挂载 DMG；不能启动仓库内的 `dist` 开发入口代替。
- **没有 artifact**：检查 Upload step 的 `if`、`path` 是否和构建输出目录一致，并确认上传步骤显示 success。验收失败时也应保留日志工件，便于定位失败发生在安装还是启动阶段。
