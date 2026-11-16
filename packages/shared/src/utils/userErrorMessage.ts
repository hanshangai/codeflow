const messages: Record<string, string> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "服务器证书链不完整或不受信任，无法建立安全连接。请联系管理员检查服务器证书配置。",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "服务器证书链不完整或不受信任，无法建立安全连接。请联系管理员检查服务器证书配置。",
  DEPTH_ZERO_SELF_SIGNED_CERT: "服务器使用了未受信任的证书，无法建立安全连接。请联系管理员配置可信证书。",
  SELF_SIGNED_CERT_IN_CHAIN: "服务器证书链包含未受信任的证书，无法建立安全连接。请联系管理员检查证书配置。",
  CERT_HAS_EXPIRED: "服务器证书已过期，无法建立安全连接。请联系管理员更新证书。",
  ERR_TLS_CERT_ALTNAME_INVALID: "服务器证书与访问地址不匹配。请检查服务器域名或联系管理员修复证书。",
  ECONNREFUSED: "服务器拒绝了连接。请确认服务已启动，并检查连接地址。",
  ECONNRESET: "网络连接已中断，请检查网络后重试。",
  ENOTFOUND: "无法解析服务器域名，请检查连接地址和网络设置。",
  EAI_AGAIN: "服务器域名暂时无法解析，请稍后重试。",
  ETIMEDOUT: "连接服务器超时，请检查网络后重试。",
  UND_ERR_CONNECT_TIMEOUT: "连接服务器超时，请检查网络后重试。",
  UND_ERR_HEADERS_TIMEOUT: "等待服务器响应超时，请稍后重试。",
  UND_ERR_SOCKET: "网络连接已中断，请检查网络后重试。",
  ENOSPC: "磁盘空间不足，请清理空间后重试。",
  EACCES: "没有访问所需文件或目录的权限，请检查权限后重试。",
  EPERM: "操作被系统拒绝，请检查文件权限或安全软件设置。",
  EBUSY: "所需文件正在被其他程序使用，请关闭相关程序后重试。",
  ENOENT: "所需文件或目录不存在，请检查安装和文件位置。",
  EIO: "读取或写入磁盘失败，请检查磁盘状态后重试。",
  ERR_IPC_CHANNEL_CLOSED: "与本机运行环境的连接已关闭，请重新启动 CodeFlow。",
  DESKTOP_DEVICE_AUTH_INVALID: "设备认证未通过，请检查账号服务器地址及安全连接配置，或联系管理员。",
  DESKTOP_DEVICE_SIGNATURE_INVALID: "设备签名验证失败，请检查本机时间和设备身份，或联系管理员。",
  DESKTOP_DEVICE_AUTH_EXPIRED: "设备认证请求已过期，请校准本机时间后重试。",
  DESKTOP_DEVICE_REVOKED: "本机设备身份已撤销，请联系管理员恢复设备资格。",
  DESKTOP_DEVICE_NOT_REGISTERED: "本机尚未在账号服务器登记，请重新关联账号。",
  DESKTOP_DEVICE_IDENTITY_CONFLICT: "本机设备身份与服务器记录冲突，请联系管理员核查。",
  DESKTOP_CLOUD_ACCOUNT_FAILED: "桌面账号关联失败，请检查账号服务器地址和网络后重试。",
  DESKTOP_CLOUD_TRANSPORT_FAILED: "无法连接账号服务器，请检查服务器地址和网络后重试。",
  DESKTOP_CLOUD_LINK_CANCELLED: "账号关联已取消，请重新选择账号后重试。",
  DESKTOP_CREDENTIAL_RELEASE_FAILED: "旧账号凭据清理失败，请重启 CodeFlow 后重试。",
  DESKTOP_UPDATE_TRANSPORT_FAILED: "无法连接更新服务器，请检查网络和更新地址后重试。",
  DESKTOP_UPDATE_HTTP_FAILED: "更新服务器返回异常响应，请稍后重试或联系管理员。",
  DESKTOP_UPDATE_RESPONSE_INVALID: "更新服务器返回的数据格式异常，请稍后重试或联系管理员。",
  DESKTOP_UPDATE_UNAVAILABLE: "更新源尚未配置，当前无法检查更新。",
  DESKTOP_UPDATE_TRANSPORT_UNAVAILABLE: "更新源尚未配置，当前无法检查更新。",
  DESKTOP_UPDATE_CONFIG_INVALID: "更新配置无效，请检查安装目录中的更新地址或使用完整安装包修复安装。",
  DESKTOP_UPDATE_ORIGIN_INVALID: "更新地址无效，请检查协议、域名和端口配置。",
  DESKTOP_OPERATION_IN_PROGRESS: "当前有其他操作正在进行，请稍后重试。",
  DESKTOP_INSTALL_APP_RUNNING: "CodeFlow 正在运行，请退出应用后重新安装。",
  DESKTOP_UNINSTALL_APP_RUNNING: "CodeFlow 或其本机运行环境仍在运行，请先退出应用再卸载。",
  DESKTOP_MAINTENANCE_PENDING: "上次安装或卸载尚未完成，请先完成原维护操作。",
  DESKTOP_UNINSTALL_BROWSER_CLEANUP_TIMEOUT: "清理应用页面数据超时，卸载已停止。请关闭应用后重试。",
  DESKTOP_UNINSTALL_WORKER_TIMEOUT: "卸载维护程序执行超时，已停止后续删除。请稍后重试。",
  DESKTOP_UNINSTALL_REQUEST_INVALID: "卸载请求无效，请重新从系统卸载入口启动。",
  DESKTOP_STARTUP_CLEANUP_FAILED: "应用启动失败，停止运行环境时也发生错误。请退出应用后重试。",
  DESKTOP_DB_SCHEMA_FORWARD_ONLY: "本地数据库可能已升级，已停止旧版本启动。请保留原数据，使用支持当前数据库版本的完整安装包修复安装。",
  DESKTOP_REINSTALL_WORKER_TIMEOUT: "修复安装程序执行超时，请稍后重试。",
  DESKTOP_MAINTENANCE_REINSTALL_FAILED: "修复安装未完成，请保留原数据并重新运行完整安装包。",
  DESKTOP_API_TIMEOUT: "本机处理请求超时，请稍后重试。",
  DESKTOP_API_RESPONSE_INVALID: "本机运行环境返回的数据格式异常，请重启 CodeFlow 后重试。",
  DESKTOP_RELEASE_BASELINE_MISSING: "安装目录缺少 baseline-release-manifest.json，请使用完整安装包修复安装后重试。",
  DESKTOP_UNINSTALL_WORKER_MISSING: "安装目录缺少 desktopUninstallWorker.cjs，请使用完整安装包修复安装后重试。",
  DESKTOP_UNINSTALL_WORKER_INVALID: "卸载维护程序文件无效，请使用完整安装包修复安装后重试。",
  DESKTOP_UNINSTALL_RELEASE_INVALID: "卸载所需的应用资源缺失或校验失败，请使用完整安装包修复安装后重试。",
  DESKTOP_MAINTENANCE_UNKNOWN_ENTRY: "应用数据目录含有未识别的文件，卸载已中止，请保留数据并查看日志。",
  DESKTOP_WEB_READY_TIMEOUT: "应用页面启动超时，请重新启动 CodeFlow。",
  DESKTOP_ERROR_LOG_FAILED: "错误日志保存失败，请检查数据目录权限和磁盘空间。",
  DESKTOP_ERROR_LOG_WRITE_FAILED: "错误日志保存失败，请检查数据目录权限和磁盘空间。",
  UNAUTHORIZED: "登录状态已失效，请重新登录。",
  FORBIDDEN: "当前账号没有执行此操作的权限。",
  NOT_FOUND: "请求的内容不存在或已被删除。",
  BAD_REQUEST: "提交的信息不完整或格式不正确，请检查后重试。",
  CONFLICT: "数据状态已发生变化，请刷新后重试。",
  RATE_LIMITED: "请求过于频繁，请稍后重试。",
  INTERNAL: "服务处理请求失败，请稍后重试。",
  NON_JSON: "服务器返回了无法识别的数据，请稍后重试。",
};

const codePattern = /\b(?:[A-Z][A-Z0-9]*_)+[A-Z0-9_]+\b/gu;

/** 按公开故障类别给出描述；未知代码由调用入口提供操作描述。 */
function describeCode(code: string): string | undefined {
  if (Object.hasOwn(messages, code)) return messages[code];
  if (/^(?:CLIENT_|DESKTOP_CLIENT_)/u.test(code)) return "本机运行环境启动失败或连接已中断，请重启 CodeFlow 后重试。";
  if (/^DESKTOP_STORAGE_/u.test(code)) return "应用数据目录无法使用，请检查目录权限、磁盘空间和原有数据完整性。";
  if (/^DESKTOP_UPDATE_.*_UNAVAILABLE$/u.test(code)) return "当前桌面版本不支持此更新操作，请使用完整安装包升级。";
  if (/^DESKTOP_UPDATE_/u.test(code)) return "更新操作未完成，请查看更新设置中的故障描述后重试。";
  if (/^DESKTOP_RELEASE_/u.test(code)) return "应用资源下载或校验失败，请重新检查更新；仍失败时请使用完整安装包修复。";
  if (/^DESKTOP_SHELL_/u.test(code)) return "桌面壳更新或启动失败，请使用完整安装包修复安装后重试。";
  if (/^DESKTOP_(?:UNINSTALL|MAINTENANCE)_/u.test(code)) return "卸载维护未完成，已停止后续删除。请保留数据并查看日志。";
  return undefined;
}

/** 默认使用固定中文描述，包含桌面账号及设备认证；原异常和诊断字段不变。 */
export function describeUserFacingError(error: unknown, fallback = "操作失败，请稍后重试；若仍失败，请查看日志或联系管理员。", preserveDescription = false): string {
  const seen = new Set<object>();
  /** 只读取数据属性，限制原因深度，避免展示边界执行未知 getter。 */
  function visit(value: unknown, depth: number): string | undefined {
    if (depth > 6 || value == null) return undefined;
    const fields = typeof value === "object" ? Object.getOwnPropertyDescriptors(value) : {};
    if (typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    const text = typeof value === "string" ? value.trim() : typeof fields.message?.value === "string" ? fields.message.value.trim() : "";
    const code = typeof fields.code?.value === "string" ? fields.code.value : typeof fields.errorCode?.value === "string" ? fields.errorCode.value : "";
    const embeddedCodes = text.match(codePattern) ?? [];
    const ownCode = embeddedCodes[0] ?? (code || text);
    const ownDescription = describeCode(ownCode || text);
    const nested = fields.errors?.value ?? fields.causes?.value;
    if (Array.isArray(nested)) {
      const descriptions = [...new Set(nested.slice(0, 8).map(child => visit(child, depth + 1)).filter((item): item is string => Boolean(item)))];
      if (ownDescription && !descriptions.includes(ownDescription)) descriptions.push(ownDescription);
      if (descriptions.length) return descriptions.join("\n");
    }
    if (ownCode.startsWith("DESKTOP_UNINSTALL_") || ownCode === "DESKTOP_RELEASE_BASELINE_MISSING") return ownDescription;
    const cause = visit(fields.cause?.value ?? fields.rootCause?.value, depth + 1);
    if (cause) return cause;
    // 服务端已经给出的自然语言说明优先保留，IPC 包装与机器码使用固定描述。
    if (preserveDescription && text && !embeddedCodes.length && !/^[A-Z][A-Z0-9_]+$/u.test(text)
      && !/^(?:Error invoking remote method|fetch failed|Error:|TypeError:)/u.test(text)) return text;
    for (const candidate of [...embeddedCodes, code, text]) {
      const description = describeCode(candidate);
      if (description) return description;
    }
    return undefined;
  }
  return visit(error, 0) ?? fallback;
}
