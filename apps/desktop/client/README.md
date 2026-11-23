# apps/desktop/client

工作区代理（Client）。引擎仅运行在 Client：Claude（先）+ Codex（后）。

## 会话投影性能约束

归并版本改变会让旧会话首次打开进入冷重建。修改归并或投影SQL时，必须同时验证旧投影升级、热增量、删除/裁剪、事务回滚和中断恢复，不能用新空库或热读结果代替。

- 高频增量只查询目标和稀疏占位索引，不逐条解析全部历史stub；新增索引由现有建表owner补齐，不为性能修复再次失效全部投影。
- 重建按8ms预算或最多256条提交并让出，至少处理一条；同归并版本中断后从提交水位接续。单条复杂事件、连接准备和提交仍可能超过预算，不能宣传硬实时保证。
- `schema_version`、`build_id`、`version`共同决定恢复资格；恢复时原子更新构建身份，使旧实例失效，另一实例已完成则直接复用。裁剪和乱序失效仍必须重建；不得跳过坏事件、伪造ready或清理用户历史绕过性能问题。
- IPC超时只说明调用方不再等待，不等于后端取消。诊断须区分投影重建、队列等待、SQLite锁冲突和首屏渲染；事件计数为0不代表未读取投影历史。

在仓库根运行 `node --conditions=development --import tsx --test apps/desktop/client/tests/thread-process-presentation.test.ts apps/desktop/client/tests/thread-presentation-performance.test.ts`。大样本验证先设置 `CODEFLOWAI_PRESENTATION_PERF=1`，再运行性能测试文件：35万条增量、2000个工具条目，检查完整正文、冷重建耗时和心跳，结束后移除该环境变量。样本使用独立合成库，不访问真实工作区。

## License

Apache License 2.0；完整文本见本目录 `LICENSE`。

