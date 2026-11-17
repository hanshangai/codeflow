# 会话终止容错修复

目标：数据库保存或普通诊断日志失败时仍可停止准确的目标引擎；正文保存失败明确返回并保留原恢复事实。

已确认边界：用户允许普通引擎诊断日志失败只告警，不允许把未保存正文当作成功。复用现有运行 owner、停止证明、事件批次和终态进度，不新增并行状态。只修改本轮登记文件，不修改 vendor 或其他已有改动。

职责：`threadSession.ts` 统一引擎诊断和保存错误；`turnInterrupt.ts` 负责目标校验、停止及终态收尾；Codex session 提供停止证明；composer 展示阶段并允许失败后的终止。

- [x] 先补失败测试：诊断写入失败不锁死会话，业务错误保持原值；应用告警也失败时明确返回双错。
- [x] 修改共享诊断入口，工作区日志失败回退应用告警；保留 code、requestId、threadId、workspaceId 和去敏根因。回退不重放原日志，不清除正文保存错误。
- [x] 先补失败测试：已有运行归属时停止先于数据库等待；未完成保存不阻止停止；重复终止不误停后继回合。
- [x] 修改原中断入口及 Codex session：停止证明先反馈，保存失败继续抛出；已知失败不跳过精确 provider 中断，未确认停止不得伪造成功。
- [x] 前端失败态保持错误提示，允许再次终止；保存进行中维持既有防重复行为。
- [x] 更新旧的严格日志测试，运行相关完整测试文件、Client/Web 类型检查、构建及改动文件 UTF-8 检查；自审 diff，并请求独立代码审查。既有失败已单独对照，不视为通过。

重点检查：跨工作区和过期 turn 不得停止新回合；停止确认后的保存错误不得重新中断；日志及告警双失败须显式失败；恢复回执及未保存正文不得清空；不修改正在使用的数据库。

## workspace.db 锁风险盘点

范围：公开 Client 当前实现的 SQLite 入口、Reader/Writer、清理和迁移。依据代码与现场日志，不对运行数据库做写入或压力实验。风险指占锁或队列阻塞的可能性，不表示下表每项已出现故障。

先区分 SQLite 文件锁、Writer 串行队列和 workspace operation gate。后两者等待不一定对应文件持锁；本次 `CLIENT_DB_LOCK_TIMEOUT` 带 SQLite 错误码 5，确属文件锁竞争。只读连接也可能持读锁，空闲连接存在本身不等于持锁。

| 场景 | 持锁/阻塞范围与风险 | 已有保护及后续重点 |
| --- | --- | --- |
| 外部 Python、数据库工具直接查询活库 | 高。DELETE 模式读游标或事务未结束，会阻碍 EXCLUSIVE 及写事务提交；不受 Client 队列控制 | 现场排障查询约 16 秒，与 3 秒锁等待超时重合，但缺持锁 PID，尚不能独占归因。排障优先应用查询接口或停写后的稳定快照，避免在游标遍历中打印大正文 |
| 多 Client/外部写进程共用同一物理工作区 | 高。各自队列和内存 gate 不能序列化另一个进程 | SQLite 保证互斥，但需单独核查部署和进程归属；应用库单实例不等于工作区跨实例互斥 |
| 正文批次提交和索引 | 高频写。`localEventPersistence.ts` 用最外层 IMMEDIATE，正文事务内还预留应用库序号，应用库等待会延长 W 事务 | 单 Writer、有界批次及固定回执；不得盲目重放已执行副作用，不放松原子性 |
| 主线程事件副作用 | 高。`index.ts` 经 `withExclusiveWorkspaceDatabase` 在 EXCLUSIVE 事务中运行同步文件/生命周期处理，慢磁盘会拉长占锁并阻塞事件循环 | 默认锁准入预算 3 秒，回调开始前才重试；开始后失败不得重放。本轮不更改模式或预算 |
| 历史、过程、投影构建及回滚证据读取 | 中至高。主线程同步 SQLite 调用执行期间，控制消息也不能被事件循环处理；全量读取或重建需关注数据规模 | 复用原仓储和短同步许可；应测慢查询和单段耗时，不把加大等待当作解决办法 |
| 需求列表 Reader Worker | 中至高。`clientDbReaderWorker.ts` 在读事务内校验 schema 并生成快照；大查询保持读事务，父 Writer 队列也等待整个读取 | 已协调 Reader/Writer，读后提交并关闭 W 连接；`clientDbReaderService.ts` 当前未见单查询超时，只有启动/关闭预算，长查询需后续独立评估 |
| 队列、偏好、会话删除、定时任务等仓储写入 | 中。共享同一物理 W，批量删除/更新及频繁提交均可能放大锁竞争 | 沿 `withWorkspaceCoreRepos` 与 Writer 同步许可；不要新增独立写连接或跨 await 事务 |
| 清理及空间统计 | 中。`clientDbCleanupService.ts` 删除及统计会访问 W；统计有读事务 | 默认每批 100 条、间隔 25 ms，统计连接在租约内关闭。现清理不是在线 VACUUM；若增加压缩必须另评估 |
| 目录迁移数据库快照 | 高且有意长读。`workspaceMigrationFileOps.ts` 从 BEGIN/读取 schema 到 await 复制整个数据库，再 ROLLBACK/close，读事务覆盖文件复制时长 | 原 gate 先排空本进程访问，取消/失败会回滚并关连接；外部访问仍可能干扰。不能直接去掉一致性读事务 |
| schema 初始化/升级和日志模式设置 | 高于普通读。`migrateClientDb.ts` 设置 DELETE，并在升级事务执行 DDL/数据变换 | 应受启动或现有迁移边界控制。迁移与 Reader 明确要求 DELETE，不能单点改 WAL |
| 旧版迁移、归档 VACUUM/VACUUM INTO | 高但非正常聊天热路径。`legacyClientMigration.ts` 包含整库整理、复制及日志模式切换 | 应保持启动/归档独占，不允许当作在线聊天修复动作 |
| 连接或回滚关闭失败 | 高。`clientDb.ts` 保留未确认关闭资源及 gate，后续拒绝访问；表现为持续不可用，不一定仍是 SQLite busy | 应定位原关闭失败并沿 owner 清理；禁止直接清错误 Map 或释放未知资源的 gate |

普通工作区日志在 `clientDb.ts:writeWorkspaceLog` 写独立 `.log`，本身不打开 W 数据库；但日志关闭未确认可能进入资源保护状态。路径索引的 `file-index.db`、知识检索索引及应用库不属于 W；仍可能通过主线程耗时或跨库事务间接影响会话。

结论：本轮保留 DELETE、EXCLUSIVE/IMMEDIATE、迁移读事务和默认等待时限；修复停止被保存/日志故障阻断。后续优先补长查询/事务耗时与持锁来源诊断，再按具体入口决定缩短事务或限制读取；不直接取消锁、切 WAL、在线 VACUUM 或延长所有超时。同步 SQLite 已在执行时，本轮控制入口修复无法抢占该同步调用。

## 验证说明

新增回归均先观察失败再实现：工作区日志回退和双日志失败、准备中/已派发本机 owner 在 DB 全失败时先反馈停止、连续保存失败仅中断一次、跨 workspace/后继 turn/未核 owner 不走快捷入口、Codex 保留原保存错误、前端失败态仍能终止。

独立审查发现并已修复桌面/API 前置数据库等待、停止证明未写回原终态进度、未派发取消证明反馈晚于数据库三项问题。本机控制资格沿原执行 owner 的已核准入事实保存，不使用 renderer 参数授予权限。

Client/Web 类型检查、无产物写入的构建及 UTF-8 检查已通过。SQLite 事务、读连接清理和事件 Writer 四个完整测试文件通过。相关集成测试有 6 个基线失败，桌面 API 完整文件有 4 个基线失败，迁移文件 Worker 有 18 个基线失败；均通过内存加载 HEAD 对应源码重现相同断言，未回退或写入任何预存文件。迁移测试含旧 `.codeflow` 夹具路径，不能据此宣称迁移安全验证通过。详细测试结果以交付时最新命令为准，不宣称全量测试通过。

## 2026-11-17 桌面停止入口补修

现场证据：测试安装的活动包为 `desktop-2026.11.17.01`，09:01:03 的 `turns.interrupt` 返回 500，根因为 `CLIENT_DB_LEGACY_ACCESS_REQUIRED`，请求 ID 为 `bcfc5ba4-8100-4e6a-a69e-77a24df97103`。只读检查日志和活动指针，没有读取或写入运行数据库。

根因：上轮为已准入本机回合增加免数据库等待的精确停止入口，但 `prepareThreadRequestBody` 在内存 owner 短路之前仍调用 `requireHostedWorkspace`。该方法通过 `WorkspaceRepo.get` 读取应用库，实际 Writer 的 guard 在引擎停止前拒绝访问。旧桌面测试只替换 `withDatabase`，没有安装真实 guard，因而没有捕获隐含的直接数据库读取。

职责仍沿用：桌面 executor 投影参数并识别已核本机 owner；API handler 复验精确回合；`turnInterrupt` 停止 provider 并推进原终态进度；Writer 为同步数据库段授予短许可，事件管线持久化正文及终态。修复只将持久化工作区校验移到精确 owner 短路之后。未核 owner、共享归属、不同工作区及后继回合继续执行原数据库校验；停止证明不代表保存成功。

- [x] 两个保存失败测试启用真实 Writer，先复现与现场一致的 guard 错误及完整调用栈，再验证准备中和运行中均先反馈停止、保存错误仍保留在原尾链。
- [x] 新增 Codex/Claude × 准备中/运行中四项桌面入口集成回归；真实 Writer 和事件管线完成终态保存，重复请求不再次中断、不重复写终态。
- [x] 复核 executor、API handler、运行态查询和停止收尾的数据库边界；独立只读评审未发现必须修复项。
- [x] 四个相关完整测试文件共 254 项，250 项通过、4 项既有失败；Client 类型检查、完整入口无落盘 esbuild、改动文件 UTF-8 和 diff 检查通过。未运行全仓库测试，不宣称全量通过。

验证命令：`node --conditions=development --import tsx --test --test-concurrency=1 apps/desktop/client/tests/desktop-api-request.test.ts apps/desktop/client/tests/turn-interrupt-handler.test.ts apps/desktop/client/tests/ordinary-turn-update-stop.test.ts apps/desktop/client/tests/local-event-writer.test.ts`。

四项既有失败均通过 Node 加载钩子仅在内存替换为 HEAD 的旧 executor，复现相同断言，没有修改工作区文件：

- `desktop bridge persists workspace CRUD through the existing handler and returns real local ownership`：工作区删除返回 500，预期 200。
- `desktop bridge refuses shared, foreign and unhosted workspaces while allowing removal of a missing root`：夹具缺少流程引擎，删除根目录后的诊断也无法落盘。
- `desktop bridge enforces one matching response and forwards non-control messages`：断言只匹配内层响应错误，实际为外层 `WORKSPACE_API_RESPONSE_FAILED`。
- `desktop terminal list restores persisted terminals under the workspace write gate`：预期的 `restoreAll` 调用没有发生。

本轮只修改已登记的 executor、桌面 API 测试和本文档；未提交、推送、发布或覆盖当前测试安装。
