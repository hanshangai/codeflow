/**
 * CLI 的 result 是一次模型调用的结束，并不一定是整个进程的结束。
 * 后台 agent 的通知会触发后续调用，期间仍需通过 stdin 回复确认。
 * 独立于 UI 子任务状态：后台 Agent 的启动 tool_result 不代表任务已完成。
 */
export class ClaudeStdinLifecycle {
  private readonly tasks = new Map<string, { background: boolean; notified: boolean }>();
  private readonly earlyNotifications = new Set<string>();
  private readonly pendingNotifications = new Set<string>();
  private readonly seenResults = new Set<string>();
  /** Claude 2.1.274 会通过 task_updated/background_tasks_changed 汇报后台任务，通知结果可能合并进 root result。 */
  private modernBackgroundTaskLifecycle = false;
  private queuedTurns = 0;
  private localInputTurns = 0;
  private readonly unacknowledgedInputIds = new Set<string>();
  /** 用于使迟到回答的兜底关闭定时器在出现后续输出或输入时失效。 */
  activityRevision = 0;

  get pendingBackgroundTasks(): number {
    return [...this.tasks.values()].filter(task => task.background && !task.notified).length;
  }

  get pendingNotificationTurns(): number {
    return this.pendingNotifications.size;
  }

  /** 尚未被普通根 result 批次收口的本地用户输入数量（仅用于诊断）。 */
  get pendingLocalInputTurns(): number {
    return this.localInputTurns;
  }

  /** 是否仍有必须保持 stdin 可写的模型轮次或通知。 */
  get hasPendingWork(): boolean {
    return this.pendingBackgroundTasks > 0
      || this.pendingNotificationTurns > 0
      || this.queuedTurns > 0
      || this.localInputTurns > 0;
  }

  /** 追加输入须先收到同 UUID 的原生回显，才能被后续根 result 收口。 */
  markLocalInputQueued(inputId?: string): void {
    this.localInputTurns += 1;
    if (inputId) this.unacknowledgedInputIds.add(inputId);
    this.activityRevision += 1;
  }

  /** 写入失败时撤销对应的本地输入登记。 */
  cancelLocalInputQueued(inputId?: string): void {
    if (inputId) this.unacknowledgedInputIds.delete(inputId);
    this.localInputTurns = Math.max(0, this.localInputTurns - 1);
    this.activityRevision += 1;
  }

  /** 返回 true 仅表示收到一条新的根 result；是否可以关闭还需检查交互请求。 */
  observe(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const event = value as Record<string, any>;
    if (event.type !== "keep_alive") this.activityRevision++;
    if (event.parent_tool_use_id || event.message?.parent_tool_use_id) return false;
    if (event.type === "user" && typeof event.uuid === "string") {
      this.unacknowledgedInputIds.delete(event.uuid);
    }

    const taskId = String(event.task_id ?? "").trim();
    if (event.type === "system"
      && (event.subtype === "background_tasks_changed" || event.subtype === "task_updated")) {
      this.modernBackgroundTaskLifecycle = true;
    }
    if (event.type === "system" && taskId) {
      if (event.subtype === "task_started" && !this.tasks.has(taskId)) {
        // 长驻 shell 服务不要求模型等待；同步 agent 的结果已在当前调用中处理。
        const background = event.task_type === "local_agent" && event.is_backgrounded !== false;
        const notified = this.earlyNotifications.delete(taskId);
        this.tasks.set(taskId, { background, notified });
        if (background && notified) this.pendingNotifications.add(taskId);
      } else if (event.subtype === "task_notification") {
        const task = this.tasks.get(taskId);
        if (!task) this.earlyNotifications.add(taskId);
        else if (!task.notified) {
          task.notified = true;
          if (task.background) this.pendingNotifications.add(taskId);
        }
      }
    }

    if (event.type !== "result") return false;
    const indexed = Number.isInteger(event.result_index);
    const resultId = indexed ? `index:${event.result_index}` : event.uuid ? `uuid:${event.uuid}` : null;
    if (resultId && this.seenResults.has(resultId)) return false;
    if (resultId) this.seenResults.add(resultId);
    this.queuedTurns = Math.max(0, Number(event.queued_turn_count) || 0);
    if (event.origin?.kind !== "task-notification") {
      if (this.queuedTurns === 0) {
        // 合并输入可共用一个 result；尚未回显的追加输入不属于该结果的已知批次。
        this.localInputTurns = this.unacknowledgedInputIds.size;
      } else if (this.localInputTurns > 0) {
        // 仍有 provider 队列时，只结算本次已返回的根轮次；后续根 result
        // 会在 queued_turn_count 归零时一次性收口剩余的合并输入。
        this.localInputTurns = Math.max(this.unacknowledgedInputIds.size, this.localInputTurns - 1);
      }
    }
    if (event.origin?.kind === "task-notification") {
      // 新 CLI 每条通知各有一个 result；queued_turn_count=0 也不能跳过其他通知。
      const next = this.pendingNotifications.values().next();
      if (!next.done) this.pendingNotifications.delete(next.value);
    } else if (this.modernBackgroundTaskLifecycle
      && this.pendingNotifications.size > 0
      && this.pendingBackgroundTasks === 0
      && this.queuedTurns === 0
      && !event.origin) {
      // 新版 Claude 在后台任务完成后可能直接发一个带 result_index 的最终 root result，
      // 不再为每个 task_notification 追加 origin=task-notification 的 result。此时继续等待
      // 通知结果会让 stdin 永远不关闭，sendMessage 也无法收到进程 close。
      this.pendingNotifications.clear();
    } else if (!indexed && !event.origin) {
      // 旧 CLI 无通知轮次元数据，通知可能合并进同一次调用。
      this.pendingNotifications.clear();
    }
    return true;
  }
}
