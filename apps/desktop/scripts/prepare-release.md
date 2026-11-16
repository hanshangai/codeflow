# 本地桌面候选工件

完整发布流程见 [桌面资源发布流程](../../../codeflow-docs/功能交付库/功能开发/桌面资源发布流程.md)。

## 统一资源发布

桌面资源更新使用共享 Release Plan，Windows 和 Mac 不得各自分配版本：

统一构建将计划的 `clientVersion` 通过仅构建时使用的 `CODEFLOWAI_CLIENT_BUILD_VERSION` 编译进 Client 和 supervisor，且按计划选择 test/prod 默认连接地址。直接构建 Client 未指定该变量时仍使用仓库根版本。资源准备使用目标 Electron 实际执行 `index.cjs --version`，核对计划版本及已签名基线版本；探测会清除运行时 `CODEFLOWAI_VERSION`，版本不符或探测失败均停止打包，不允许靠修改健康检查或清单掩盖旧产物。

```bash
# 只在 Windows 协调机执行一次；Mac 使用同一个 plan 文件
pnpm release:desktop plan:new --test --platforms win,mac-arm64 --key-id <keyId>

# Windows 构建内置 client + web 资源包
pnpm release:desktop build --plan <plan.json> --platform win --mode resources \
  --private-key <private.pem> --trust <trust.json>

# Mac arm64 构建同一版本的资源包，产物直接复制到共享目录
pnpm release:desktop build --plan <plan.json> --platform mac-arm64 --mode resources \
  --private-key <private.pem> --trust <trust.json> --shared-dir <共享目录>

# Windows 汇总两个平台并发布；--upload 自动创建远端目录并上传
pnpm release:desktop publish --plan <plan.json> --trust <trust.json> \
  --artifacts <共享产物目录> --upload
```

`--mode resources` 只生成 `bundle.tar.gz + manifest.json`，不生成安装包；桌面壳从 Server 获取资源更新。需要安装包时再使用 `--mode installer`（Windows）或 `--mode dmg`（Mac），并传 `--update-origin <https://...>` 写入安装包的更新源。

统一入口也支持按范围发布：

```bash
pnpm release --test --scope server    # Server + Web
pnpm release --test --scope win       # 仅当前 Windows 资源
pnpm release --test --scope mac       # 仅当前 arm64 Mac 资源
pnpm release --test --scope desktop   # 当前平台构建，配合 --publish 汇总发布
pnpm release --test --scope all       # 先 Server/Web，再当前桌面平台
```

`plan:new` 生成 `release/desktop-plans/<version>.json`，包含 `releaseId/version/sourceCommit/dbSchemaVersion/keyId/platformSet`。创建计划要求工作区干净；两个构建机必须处于同一 Git commit、使用同一个 plan 和同一个签名信任根；`publish` 会拒绝版本、平台或元数据不一致的 bundle。

`publish --upload` 会创建本地/远端资源目录，并在上传前检查 Server 配置路径上的 `trust.json`；该公钥文件必须由发布方提前放置，不会自动生成或覆盖。

当前只支持 `win32/x64 + darwin/arm64`；`darwin/x64` 需要在 Intel Mac 或 x64 macOS CI 上构建，暂不纳入计划。注意：Server 生产发布校验仍要求三平台，`win32/x64 + darwin/arm64` 目前可用于测试环境；arm64-only 生产发布需要另行调整平台策略。

## 本地桌面候选工件

先完成 shared、Web、Client、壳构建，并用既有 `prepare:resources` 装配完整资源。基础壳版本取 `apps/desktop/package.json`，主版本统一为两位，普通资源发布保持 `1.0`。electron-builder 内部要求三段版本时自动补为 `1.0.0`，不影响对外展示版本。

在 `apps/desktop` 执行：

```powershell
pnpm prepare:release <完整资源目录> <候选根目录> <metadata.json> <签名私钥.pem> <更新日志.md>
pnpm prepare:release --verify <候选根目录/2026.11.09.01>
```

输出目录必须与资源目录、`apps/desktop` 相互独立，例如仓库根的 `release/desktop-candidates`；私钥必须在资源、壳和候选目录之外，不得混入任何打包输入或用作更新日志。工具不生成签名密钥，不上传、不变更公开下载或正式日志。

`metadata.json` 沿用资源清单字段：

```json
{
  "webVersion": "2026.11.09.01",
  "clientVersion": "2026.11.09.01",
  "protocolVersion": 1,
  "capabilityVersion": 1,
  "dbSchemaVersion": 96,
  "platform": "win32",
  "arch": "x64",
  "expiresAt": "2027-11-09T00:00:00.000Z",
  "keyId": "已安装信任根中的密钥标识"
}
```

Web/Client 版本和数据库结构版本须填写已构建工件的实际事实；到期时间须晚于创建时间。工具自动生成 `releaseId`、内部版本和创建时间，不允许元数据覆盖。它复用根发布脚本的 `YYYY.MM.DD.NN` 编号和本地根版本基线；不会改写任何源码版本。

候选目录保存签名资源包 `bundle/`、配套完整安装器 `installer-attempt-N/`、安装基线资源 `installation-resources/`、`release-notes.md`、候选记录及 `events.jsonl`。默认真实执行既有本地 NSIS 构建，安装器不签名且不会运行。资源包仍要求显式 Ed25519 签名，并重验目标壳 Node/ABI、held 启动标记和完整库存。

同样命令重试会按输入指纹复用内部版本数字最大的候选编号并校验已完成工件，`.100` 高于 `.99`；失败安装尝试保留现场，下次使用新尝试目录。资源、壳输入、元数据或日志变化时，须显式追加 `--new` 创建新候选。同日序号递增，跨日从 `01` 开始；新候选不覆盖旧候选。完成的候选被改坏时复验直接失败，须查明原因，不能用重试覆盖证据。

日期目录创建后即占号；若进程在初始候选记录落盘前中断，后续保留该目录和编号，在新候选日志中记录 `DESKTOP_CANDIDATE_ALLOCATION_INCOMPLETE`，继续分配更高编号。已有工件却缺记录，以及记录的坏编码、坏 JSON 或读取故障仍会阻止生成，`--new` 不绕过损坏记录。

同一候选根禁止并行执行。进程被强制终止可能留下 `.prepare.lock`；先确认没有候选生成进程，再人工删除该锁。保留不完整目录用于排障，磁盘、签名、兼容性或构建失败均以非零退出。

## 同候选发布准备与登记

Windows 候选加上同 `releaseId`、内部版本、Web/Client 版本和协议/数据库结构的两份已签名 Mac 资源包，组成原 Server 要求的完整三平台。Mac 工件沿原 `build-release-bundle.mjs` 生成，元数据取候选的 `candidate.json.metadata`，仅改实际平台为 `darwin` 和架构为 `x64` / `arm64`。缺任一平台或内容损坏直接失败，不用 Windows 包填充 Mac 平台。Server 按归档摘要定位唯一清单，不同平台若共用同一归档摘要会明确拒绝，避免覆盖清单。

在 `apps/desktop` 运行离线导出，`trust.json` 是独立核对的已安装公钥信任根：

```powershell
node --conditions=development --import tsx scripts/prepare-publication.mjs <Windows候选> <Mac-x64资源包> <Mac-arm64资源包> <全新发布准备目录> <trust.json>
```

导出和复验逐份验签、安全解包并核对 held 能力和完整库存，再检查已签名 `client/desktop-runtime.json` 的平台、架构与各自清单一致，Node 主版本和 modules ABI 与 Windows 候选目标壳一致。缺少运行时事实或不兼容直接失败；Mac 包仍须在目标平台沿资源准备入口完成真实依赖与原生模块自检，导出工具不跨平台执行 Mac 二进制。准备目录包含：

- `artifacts/<archiveSha256>/manifest.json` 与 `bundle.tar.gz`：原 Server 桌面资源目录布局。
- `installers/<sha256>/CodeFlowAI-<展示版本>-win32-x64.exe` 与 `full-installer.json`：原完整安装包独立登记格式；展示版本与桌面端界面共用 `formatDesktopVersion`，例如内部版本 `2026.11.09.01` 对应 `1.0.1109`。
- `release-notes/<内部版本>.md`：同候选日志的原字节，沿 Server 已归档版本文件名规则。
- `candidate.json` 与 `publish-input.json`：候选来源和原 PostgreSQL `publish` 的精确三平台输入。

`publishedAt` 首次完整导出后固定。相同命令复验并复用原材料，不重新分配发布时间；原工件或准备目录损坏、输入变更与发布时间冲突均显式失败。导出不连接数据库，不覆盖公开下载登记，也不写源码或 Server 的正式日志目录。

官方来源签名、上传及Server登记由独立私有工程维护。本仓库仅生成与校验本地开发材料；官方发布需要受控构建与单独授权。

## macOS 本地安装包

macOS 包只在 macOS 构建机生成：先构建 Web、Client 与壳，并使用同一构建机上的 Electron 执行 `prepare:resources`，确保 `client/desktop-runtime.json` 与 `node-pty` prebuilds 对应当前架构。当前 Electron 45 要求最低 macOS 13 Ventura，打包配置会写入 `LSMinimumSystemVersion=13.0`；macOS 12 Monterey 及以下不支持。

```bash
pnpm -C apps/desktop package:local:mac -- <完整资源目录> <新独占输出目录> --target dir
pnpm -C apps/desktop package:local:mac -- <完整资源目录> <新独占输出目录> --target dmg
```

命令关闭官方 Developer ID 签名与 hardened runtime，但在 `afterPack` 阶段对 `.app` 做 ad-hoc 签名并执行 `codesign --verify`；DMG 使用拖拽到 Applications 的布局。ad-hoc 签名只能降低 Apple Silicon 直接判损坏的概率，不能替代 Developer ID 签名和公证。资源目录没有签名基线时，输出会携带 `desktop-unsigned-local.json`，应用仅跳过打包态基线要求，并在启动日志中记录 `DESKTOP_UNSIGNED_LOCAL_BASELINE_SKIPPED`；该标记不能替代签名、公证或正式发布材料。提供 `baseline-release-manifest.json` 时可用 `--require-baseline-proof` 先复验完整 held payload。

CI 或无交互构建可使用 `bash tools/ci/build-macos-dmg.sh <新独占输出目录>`；脚本会构建资源、安装固定 npm 12.2.2、生成 Client 归档并调用上述 DMG 打包入口。`.github/workflows/desktop-dmg.yml` 当前只在 `macos-15`（arm64）产出 DMG；x64 Mac 包需要 Intel Mac 或 x64 macOS CI。

macOS 应用内托盘提供“卸载 CodeFlow…”：确认后停止 Client，清理授权数据与缓存，保留默认工作区与未知文件，再把 `.app` 移入废纸篓。卸载结果写入 `~/Library/Logs/CodeFlow/macos-uninstall.log`。
