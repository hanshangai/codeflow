<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import {
  workspaceIdsReferToSameWorkspace,
  type SharedWorkspaceAssetMaintenanceAuthorizedMember,
  type SharedWorkspaceAssetMaintenanceMode,
  type SharedWorkspaceAssetMaintenancePolicy,
  type SharedWorkspaceFileTransferPolicy,
  type WorkspaceFileTransferDirection,
  type WorkspaceFileTransferStatus,
  type SharedWorkspaceHostStatus,
  type SharedWorkspaceInviteCandidate,
  type SharedWorkspaceListItem,
  type SharedWorkspaceMemberItem,
  type SharedWorkspaceUsageEligibilityReason,
} from "@codeflowai/shared";

import { useAccountStore } from "../../../store/account";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useSharedWorkspacesStore } from "../../../store/sharedWorkspaces";
import { useWorkspacesStore } from "../../../store/workspaces";
import { getWorkspaceDisplayTitle } from "../../../utils/workspaceDisplay";

defineOptions({ name: "SharedWorkspacePanel" });

type SharedWorkspaceListQuery = Record<string, string | number | boolean | undefined | null>;

const sharedWorkspaces = useSharedWorkspacesStore();
const account = useAccountStore();
const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();

const enterpriseSummaryLoading = ref(false);
const enterpriseSummaryError = ref("");
let enterpriseMembersLoadRevision = 0;
const keyword = ref("");
const hostStatusFilter = ref<SharedWorkspaceHostStatus | undefined>(undefined);
const createOpen = ref(false);
const editOpen = ref(false);
const hostBindOpen = ref(false);
const membersOpen = ref(false);
const memberDrawerTab = ref<"members" | "invite" | "assetMaintenance" | "fileTransfer">("members");
const candidateSearch = ref("");
const inviteUserIds = ref<string[]>([]);
const includeUnavailable = ref(false);
const transferDirectionFilter = ref<WorkspaceFileTransferDirection | undefined>(undefined);
const transferStatusFilter = ref<WorkspaceFileTransferStatus | undefined>(undefined);
const transferKeyword = ref("");
const assetMaintainerSearch = ref("");
const transferPolicyForm = reactive<SharedWorkspaceFileTransferPolicy>({
  uploadEnabled: false,
  downloadEnabled: false,
  maxFileSizeBytes: 50 * 1024 * 1024,
  uploadRateLimitBytesPerSecond: 1024 * 1024,
  downloadRateLimitBytesPerSecond: 1024 * 1024,
  maxConcurrentTransfers: 2,
});
const assetMaintenancePolicyForm = reactive<SharedWorkspaceAssetMaintenancePolicy>({
  mode: "selected_members",
  authorizedMemberUserIds: [],
  memberAssetMaintenanceEnabled: false,
});
const MIB_BYTES = 1024 * 1024;
let candidateSearchTimer: ReturnType<typeof setTimeout> | null = null;

const createForm = reactive({
  name: "",
  description: "",
  workspaceAdminUserId: "",
});

const editForm = reactive({
  sharedWorkspaceId: "",
  name: "",
});

const hostBindForm = reactive({
  sharedWorkspaceId: "",
  hostClientId: "",
  localWorkspaceId: "",
});

const isEnterpriseAdmin = computed(() => config.accountRole === "enterprise_admin" && Boolean(config.userSummary?.enterpriseId));
const managedEnterpriseId = computed(() => config.userSummary?.enterpriseId ?? null);
const canCreate = computed(() => Boolean(managedEnterpriseId.value) && isEnterpriseAdmin.value);

const filteredItems = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return sharedWorkspaces.items;
  return sharedWorkspaces.items.filter((item) => {
    const haystack = [
      item.name,
      item.description,
      item.workspaceAdminName,
      item.workspaceAdminEmail,
      item.host?.localWorkspaceLabel,
      item.host?.localWorkspaceId,
    ].map((part) => String(part ?? "").toLowerCase()).join(" ");
    return haystack.includes(text);
  });
});

const selectedWorkspace = computed(() =>
  sharedWorkspaces.items.find((item) => item.id === sharedWorkspaces.selectedWorkspaceId) ?? null,
);
const selectedWorkspaceId = computed(() => selectedWorkspace.value?.id ?? "");
const selectedMembers = computed(() =>
  selectedWorkspaceId.value ? (sharedWorkspaces.membersByWorkspaceId[selectedWorkspaceId.value] ?? []) : [],
);
const selectedInviteCandidates = computed(() =>
  selectedWorkspaceId.value
    ? sharedWorkspaces.inviteCandidatesByWorkspaceId[selectedWorkspaceId.value] ?? { available: [], unavailable: [] }
    : { available: [], unavailable: [] },
);
const selectedTransferPolicy = computed(() =>
  selectedWorkspaceId.value ? (sharedWorkspaces.fileTransferPoliciesByWorkspaceId[selectedWorkspaceId.value] ?? selectedWorkspace.value?.fileTransferPolicy ?? null) : null,
);
const selectedAssetMaintenancePolicy = computed(() =>
  selectedWorkspaceId.value
    ? sharedWorkspaces.assetMaintenancePoliciesByWorkspaceId[selectedWorkspaceId.value] ?? selectedWorkspace.value?.assetMaintenancePolicy ?? null
    : null,
);
const selectedAssetMaintenanceAuthorizedMembers = computed(() =>
  selectedWorkspaceId.value
    ? sharedWorkspaces.assetMaintenanceAuthorizedMembersByWorkspaceId[selectedWorkspaceId.value] ?? []
    : [],
);
const selectedTransferEvents = computed(() =>
  selectedWorkspaceId.value ? sharedWorkspaces.fileTransfersByWorkspaceId[selectedWorkspaceId.value] ?? { items: [], total: 0 } : { items: [], total: 0 },
);
const canManageSelectedTransfer = computed(() => {
  const role = selectedWorkspace.value?.currentUserRole ?? "";
  return role === "workspace_admin" || role === "enterprise_admin" || role === "creator";
});
const canManageSelectedAssetMaintenance = computed(() => canManageSelectedTransfer.value);
const transferQuery = computed(() => ({
  direction: transferDirectionFilter.value,
  status: transferStatusFilter.value,
  keyword: transferKeyword.value.trim() || undefined,
  offset: 0,
  limit: 20,
}));
const transferMaxFileSizeMib = computed({
  get: () => bytesToMib(transferPolicyForm.maxFileSizeBytes),
  set: (value: number | null) => {
    transferPolicyForm.maxFileSizeBytes = mibToBytes(value, 1);
  },
});
const transferUploadRateMib = computed({
  get: () => bytesToMib(transferPolicyForm.uploadRateLimitBytesPerSecond),
  set: (value: number | null) => {
    transferPolicyForm.uploadRateLimitBytesPerSecond = mibToBytes(value, 1024);
  },
});
const transferDownloadRateMib = computed({
  get: () => bytesToMib(transferPolicyForm.downloadRateLimitBytesPerSecond),
  set: (value: number | null) => {
    transferPolicyForm.downloadRateLimitBytesPerSecond = mibToBytes(value, 1024);
  },
});

const assetMaintainerRows = computed<SharedWorkspaceAssetMaintenanceAuthorizedMember[]>(() => {
  const memberMap = new Map(selectedMembers.value.map((member) => [member.userId, member]));
  const serverMap = new Map(selectedAssetMaintenanceAuthorizedMembers.value.map((member) => [member.userId, member]));
  return assetMaintenancePolicyForm.authorizedMemberUserIds.map((userId) => {
    const member = memberMap.get(userId);
    if (member) {
      const effective = member.status === "active"
        && member.role === "member"
        && member.usageEligibility?.eligible === true;
      return {
        userId,
        displayName: member.displayName || member.email || userId,
        email: member.email,
        role: member.role,
        status: member.status,
        effective,
        disabledReason: effective
          ? null
          : member.role === "workspace_admin"
            ? "admin_default_maintainer"
            : member.usageEligibility?.reasons[0] ?? "not_active_shared_member",
        usageEligibility: member.usageEligibility ?? null,
      };
    }
    return serverMap.get(userId) ?? {
      userId,
      displayName: userId,
      email: "",
      role: null,
      status: null,
      effective: false,
      disabledReason: "not_active_shared_member",
    };
  });
});

const assetMaintainerCandidates = computed(() => {
  const selected = new Set(assetMaintenancePolicyForm.authorizedMemberUserIds);
  const keyword = assetMaintainerSearch.value.trim().toLowerCase();
  return selectedMembers.value
    .filter((member) => member.status === "active" && member.role === "member" && member.usageEligibility?.eligible === true && !selected.has(member.userId))
    .filter((member) => {
      if (!keyword) return true;
      return `${member.displayName} ${member.email} ${member.userId}`.toLowerCase().includes(keyword);
    });
});

const enterpriseEligibilityHint = computed(() => {
  if (enterpriseSummaryLoading.value) return "企业资格加载中";
  if (enterpriseSummaryError.value) return enterpriseSummaryError.value;
  const summary = account.enterpriseSummary;
  if (!summary || summary.enterpriseId !== managedEnterpriseId.value) return "企业资格尚未加载";
  return summary.status === "active" ? "" : "企业已停用";
});
const workspaceAdminOptions = computed(() =>
  (canCreate.value ? account.enterpriseMembers : [])
    .filter((item) => item.accountStatus === "active")
    .map((item) => ({
      value: item.userId,
      label: item.fullName || item.email || item.userId,
      email: item.email,
      disabled: item.keyStatus !== "active" || Boolean(enterpriseEligibilityHint.value),
      hint: item.keyStatus !== "active" ? "无可用 Key" : enterpriseEligibilityHint.value,
    })),
);

function findWorkspaceById(workspaceId: string) {
  return workspaces.workspaces.find((workspace) => workspaceIdsReferToSameWorkspace(workspace.id, workspaceId)) ?? null;
}

const hostWorkspaceOptions = computed(() => {
  const options: Array<{ value: string; clientId: string; workspaceId: string; label: string; clientLabel: string; pathLabel: string; disabled?: boolean }> = [];
  const boundHost = selectedWorkspace.value?.host ?? null;
  for (const client of presence.online.onlineClients) {
    for (const workspaceId of client.workspaceIds) {
      const workspace = findWorkspaceById(workspaceId);
      const matchesBoundHost = Boolean(boundHost?.localWorkspaceId)
        && workspaceIdsReferToSameWorkspace(workspaceId, boundHost?.localWorkspaceId ?? "");
      if (!workspace && !matchesBoundHost) continue;
      const boundHostLabel = String(boundHost?.localWorkspaceLabel ?? "").trim();
      const label = workspace
        ? getWorkspaceDisplayTitle(workspace)
        : boundHostLabel || compactWorkspaceIdLabel(workspaceId);
      const clientLabel = client.name || client.clientId;
      options.push({
        value: `${client.clientId}::${workspaceId}`,
        clientId: client.clientId,
        workspaceId,
        label,
        clientLabel,
        pathLabel: workspace?.path ?? (matchesBoundHost ? "当前绑定执行主机工作区" : compactWorkspaceIdLabel(workspaceId)),
      });
    }
  }
  return options;
});

function compactWorkspaceIdLabel(workspaceId: string): string {
  const raw = String(workspaceId ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(":").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

function formatCreatedAt(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 将字节值转换为管理表单使用的 MB 数值。 */
function bytesToMib(bytes: number | null | undefined): number {
  const value = Number(bytes ?? 0);
  return Number.isFinite(value) && value > 0 ? Number((value / MIB_BYTES).toFixed(3)) : 0;
}

/** 将管理表单输入的 MB 数值转换为服务端策略使用的整数字节。 */
function mibToBytes(value: number | null | undefined, minBytes: number): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return minBytes;
  return Math.max(minBytes, Math.round(numeric * MIB_BYTES));
}

const tableColumns = [
  { title: "共享工作区", dataIndex: "name", key: "name" },
  { title: "当前情况", dataIndex: "current", key: "current" },
  { title: "管理员", dataIndex: "workspaceAdminName", key: "admin" },
  { title: "操作", key: "actions", width: 200, align: "right" as const },
];

const memberColumns = [
  { title: "成员", dataIndex: "displayName", key: "member" },
  { title: "角色", dataIndex: "role", key: "role", width: 120 },
  { title: "成员状态", dataIndex: "status", key: "status", width: 96, align: "right" as const },
  { title: "操作", key: "actions", width: 72, align: "right" as const },
];

const inviteCandidateColumns = [
  { title: "候选人", dataIndex: "displayName", key: "candidate" },
  { title: "资格", dataIndex: "eligible", key: "eligible", width: 130, align: "right" as const },
];

const transferColumns = [
  { title: "文件", key: "file" },
  { title: "方向", key: "direction", width: 80 },
  { title: "状态", key: "status", width: 90 },
  { title: "操作者", key: "actor", width: 140 },
  { title: "时间", key: "time", width: 150 },
];

const visibleInviteCandidates = computed<SharedWorkspaceInviteCandidate[]>(() => {
  const data = selectedInviteCandidates.value;
  return includeUnavailable.value ? [...data.available, ...data.unavailable] : data.available;
});

const inviteRowSelection = computed(() => ({
  selectedRowKeys: inviteUserIds.value,
  onChange: (keys: (string | number)[]) => {
    inviteUserIds.value = keys.map(String);
  },
  getCheckboxProps: (record: SharedWorkspaceInviteCandidate) => ({ disabled: !record.eligible }),
}));

/** 判断是否展示共享关系删除入口，避免账号级企业管理员被行内成员角色覆盖。 */
function canManageRow(record: SharedWorkspaceListItem): boolean {
  if (["enterprise_admin", "creator"].includes(record.currentUserRole || "")) return true;
  return canManageEnterpriseWorkspace(record);
}

/** 判断账号级企业管理权限是否覆盖当前共享工作区。 */
function canManageEnterpriseWorkspace(record: SharedWorkspaceListItem): boolean {
  const enterpriseId = managedEnterpriseId.value;
  if (!enterpriseId || record.enterpriseId !== enterpriseId) return false;
  return isEnterpriseAdmin.value;
}

/** 判断当前行是否允许打开 Host 绑定弹框。 */
function canBindHost(record: SharedWorkspaceListItem): boolean {
  return record.currentUserRole === "workspace_admin";
}

/** 判断当前行是否允许取消已有 Host 绑定。 */
function canUnbindHost(record: SharedWorkspaceListItem): boolean {
  return ["enterprise_admin", "creator", "workspace_admin"].includes(record.currentUserRole || "");
}

/** 仅把 online/offline 或存在绑定详情的行视作已绑定。 */
function isHostBound(record: SharedWorkspaceListItem): boolean {
  return Boolean(record.host) || record.hostStatus === "online" || record.hostStatus === "offline";
}

/** 判断当前登录人是否能在成员抽屉移除该成员。 */
function canRemoveMember(record: SharedWorkspaceMemberItem): boolean {
  return selectedWorkspace.value?.currentUserRole === "workspace_admin"
    && record.role === "member"
    && record.status === "active";
}

function onCandidateSearchInput(): void {
  if (candidateSearchTimer) clearTimeout(candidateSearchTimer);
  candidateSearchTimer = setTimeout(() => {
    void refreshInviteCandidates();
  }, 300);
}

const routeColumns = [
  { title: "事件", key: "event" },
  { title: "状态", key: "status" },
  { title: "时间", key: "ts" },
];

function hostStatusLabel(status: SharedWorkspaceHostStatus | null | undefined): string {
  if (status === "online") return "Host 在线";
  if (status === "offline") return "Host 离线";
  if (status === "unbound") return "待绑定 Host";
  return "未知";
}

function hostStatusColor(status: SharedWorkspaceHostStatus | null | undefined): string {
  if (status === "online") return "green";
  if (status === "offline") return "red";
  return "orange";
}

function roleLabel(role: SharedWorkspaceListItem["currentUserRole"] | SharedWorkspaceMemberItem["role"] | null | undefined): string {
  if (role === "workspace_admin") return "工作区管理员";
  if (role === "enterprise_admin") return "企业管理员";
  if (role === "creator") return "创建者";
  if (role === "member") return "成员";
  return "无权限";
}

function disabledReasonLabel(reason: SharedWorkspaceUsageEligibilityReason | null | undefined): string {
  const map: Record<SharedWorkspaceUsageEligibilityReason, string> = {
    already_member: "已在空间内",
    not_enterprise_member: "非同企业成员",
    enterprise_member_inactive: "企业成员不可用",
    account_disabled: "账号已禁用",
    api_key_missing: "缺少可用 API Key",
    enterprise_unavailable: "企业权益不可用",
    usage_unknown: "使用资格未知",
  };
  return reason ? map[reason] : "可邀请";
}

function transferDirectionLabel(direction: string): string {
  return direction === "upload" ? "上传" : "下载";
}

function transferStatusColor(status: string): string {
  if (status === "succeeded") return "green";
  if (status === "running") return "blue";
  if (status === "rejected") return "orange";
  if (status === "failed" || status === "cancelled") return "red";
  return "default";
}

function transferStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "等待",
    running: "传输中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
    rejected: "已拒绝",
  };
  return labels[status] ?? status;
}

function applyTransferPolicyToForm(policy: SharedWorkspaceFileTransferPolicy | null): void {
  const source = policy ?? {
    uploadEnabled: false,
    downloadEnabled: false,
    maxFileSizeBytes: 50 * 1024 * 1024,
    uploadRateLimitBytesPerSecond: 1024 * 1024,
    downloadRateLimitBytesPerSecond: 1024 * 1024,
    maxConcurrentTransfers: 2,
  };
  transferPolicyForm.uploadEnabled = source.uploadEnabled;
  transferPolicyForm.downloadEnabled = source.downloadEnabled;
  transferPolicyForm.maxFileSizeBytes = source.maxFileSizeBytes;
  transferPolicyForm.uploadRateLimitBytesPerSecond = source.uploadRateLimitBytesPerSecond;
  transferPolicyForm.downloadRateLimitBytesPerSecond = source.downloadRateLimitBytesPerSecond;
  transferPolicyForm.maxConcurrentTransfers = source.maxConcurrentTransfers;
}

/** 将资产维护策略回填到后台开关表单。 */
function applyAssetMaintenancePolicyToForm(policy: SharedWorkspaceAssetMaintenancePolicy | null): void {
  assetMaintenancePolicyForm.mode = policy?.mode ?? (policy?.memberAssetMaintenanceEnabled ? "all_members" : "selected_members");
  assetMaintenancePolicyForm.authorizedMemberUserIds = [...(policy?.authorizedMemberUserIds ?? [])];
  assetMaintenancePolicyForm.memberAssetMaintenanceEnabled = assetMaintenancePolicyForm.mode === "all_members";
}

/** 切换资产维护模式；从全员改为指定成员时提醒权限会收窄。 */
function setAssetMaintenanceMode(mode: SharedWorkspaceAssetMaintenanceMode): void {
  if (!canManageSelectedAssetMaintenance.value || assetMaintenancePolicyForm.mode === mode) return;
  const apply = () => {
    assetMaintenancePolicyForm.mode = mode;
    assetMaintenancePolicyForm.memberAssetMaintenanceEnabled = mode === "all_members";
  };
  if (assetMaintenancePolicyForm.mode === "all_members" && mode === "selected_members") {
    Modal.confirm({
      title: "切换为指定成员编辑",
      content: "保存后，未在名单内的普通成员将不能维护共享资产定义，但仍可读取和使用共享资产。",
      okText: "继续切换",
      cancelText: "取消",
      onOk: apply,
    });
    return;
  }
  apply();
}

/** 添加一个普通成员到资产维护授权名单。 */
function addAssetMaintainer(userId: string): void {
  const normalized = String(userId ?? "").trim();
  if (!normalized || assetMaintenancePolicyForm.authorizedMemberUserIds.includes(normalized)) return;
  assetMaintenancePolicyForm.authorizedMemberUserIds = [...assetMaintenancePolicyForm.authorizedMemberUserIds, normalized];
}

/** 从资产维护授权名单移除一个成员。 */
function removeAssetMaintainer(userId: string): void {
  assetMaintenancePolicyForm.authorizedMemberUserIds = assetMaintenancePolicyForm.authorizedMemberUserIds.filter((item) => item !== userId);
}

function assetMaintainerDisabledReasonLabel(reason: SharedWorkspaceAssetMaintenanceAuthorizedMember["disabledReason"]): string {
  if (reason === "admin_default_maintainer") return "管理员默认具备权限";
  if (reason === "not_active_shared_member") return "已失效";
  if (reason) return disabledReasonLabel(reason);
  return "不生效";
}

/** 生成共享空间列表 query，确保超管刷新保留企业作用域与筛选条件。 */
function buildListQuery(enterpriseId = managedEnterpriseId.value): SharedWorkspaceListQuery | null {
  if (!enterpriseId) return null;
  return {
    enterpriseId,
    hostStatus: hostStatusFilter.value,
  };
}

/** 仅企业管理角色读取创建候选；权限或范围变化后拒绝迟到结果，实际失败保持显式。 */
async function loadEnterpriseMembers(force = false): Promise<void> {
  const enterpriseId = managedEnterpriseId.value;
  const requestRevision = ++enterpriseMembersLoadRevision;
  if (!enterpriseId || !canCreate.value) {
    enterpriseSummaryLoading.value = false;
    enterpriseSummaryError.value = "";
    return;
  }
  enterpriseSummaryLoading.value = true;
  enterpriseSummaryError.value = "";
  try {
    await Promise.all([
      account.loadEnterpriseSummary(force, { enterpriseId }),
      account.loadEnterpriseMembers(force, {
        enterpriseId, page: 1, pageSize: 100,
        silent: !force && Boolean(account.enterpriseMembers.length),
      }),
    ]);
  } catch {
    if (managedEnterpriseId.value !== enterpriseId || requestRevision !== enterpriseMembersLoadRevision) return;
    enterpriseSummaryError.value = "企业资格加载失败，请重试";
    message.error(enterpriseSummaryError.value);
    return;
  } finally {
    if (requestRevision === enterpriseMembersLoadRevision) enterpriseSummaryLoading.value = false;
  }
  if (managedEnterpriseId.value !== enterpriseId || requestRevision !== enterpriseMembersLoadRevision) return;
  if (!createForm.workspaceAdminUserId) {
    const first = workspaceAdminOptions.value.find((item) => !item.disabled);
    createForm.workspaceAdminUserId = first?.value ?? "";
  }
}

/** 加载共享空间列表，并保留当前企业与 Host 状态筛选。 */
async function loadList(): Promise<void> {
  const query = buildListQuery();
  if (!query) return;
  const result = await sharedWorkspaces.loadList(query);
  if (!result.ok) {
    message.error(result.message || "共享工作区列表加载失败");
  }
}

/** 刷新列表并重试企业资格，避免加载失败后候选一直不可选。 */
async function refreshPanel(): Promise<void> {
  await Promise.all([loadEnterpriseMembers(true), loadList()]);
}

function openCreate(): void {
  createForm.name = "";
  createForm.description = "";
  createForm.workspaceAdminUserId = workspaceAdminOptions.value.find((item) => !item.disabled)?.value ?? "";
  createOpen.value = true;
}

/** 打开共享工作区名称编辑弹框。 */
function openEdit(record: SharedWorkspaceListItem): void {
  if (!canManageEnterpriseWorkspace(record)) return;
  editForm.sharedWorkspaceId = record.id;
  editForm.name = record.name;
  editOpen.value = true;
}

/** 保存共享工作区名称并刷新当前企业列表。 */
async function submitEdit(): Promise<void> {
  if (!editForm.sharedWorkspaceId) return;
  const result = await sharedWorkspaces.updateWorkspace(
    editForm.sharedWorkspaceId,
    { name: editForm.name },
    buildListQuery() ?? undefined,
  );
  if (!result.ok) {
    message.error(result.message || "修改共享工作区名称失败");
    return;
  }
  message.success("共享工作区名称已更新");
  editOpen.value = false;
}

/** 创建共享空间定义，并沿用当前列表 scope 刷新。 */
async function submitCreate(): Promise<void> {
  const enterpriseId = managedEnterpriseId.value;
  if (!enterpriseId) return;
  const query = buildListQuery(enterpriseId);
  const result = await sharedWorkspaces.create({
    enterpriseId,
    name: createForm.name,
    description: createForm.description,
    workspaceAdminUserId: createForm.workspaceAdminUserId,
  }, query ?? { enterpriseId });
  if (!result.ok) {
    message.error(result.message || "创建共享工作区失败");
    return;
  }
  message.success("共享工作区已创建，等待工作区管理员绑定 Host");
  createOpen.value = false;
}

function openHostBind(record: SharedWorkspaceListItem): void {
  sharedWorkspaces.setSelectedWorkspace(record.id);
  hostBindForm.sharedWorkspaceId = record.id;
  hostBindForm.hostClientId = "";
  hostBindForm.localWorkspaceId = "";
  const current = record.host?.localWorkspaceId
    ? hostWorkspaceOptions.value.find((item) => workspaceIdsReferToSameWorkspace(item.workspaceId, record.host?.localWorkspaceId ?? ""))
    : null;
  const selected = current ?? hostWorkspaceOptions.value[0];
  if (selected) {
    hostBindForm.hostClientId = selected.clientId;
    hostBindForm.localWorkspaceId = selected.workspaceId;
  }
  hostBindOpen.value = true;
}

function handleHostWorkspaceSelect(value: string): void {
  const option = hostWorkspaceOptions.value.find((item) => item.value === value);
  hostBindForm.hostClientId = option?.clientId ?? "";
  hostBindForm.localWorkspaceId = option?.workspaceId ?? "";
}

async function submitHostBind(): Promise<void> {
  if (!hostBindForm.sharedWorkspaceId) return;
  const selectedLocalWorkspace = findWorkspaceById(hostBindForm.localWorkspaceId);
  const result = await sharedWorkspaces.bindHost(hostBindForm.sharedWorkspaceId, {
    hostClientId: hostBindForm.hostClientId,
    localWorkspaceId: hostBindForm.localWorkspaceId,
    localWorkspaceLabel: selectedLocalWorkspace
      ? getWorkspaceDisplayTitle(selectedLocalWorkspace)
      : compactWorkspaceIdLabel(hostBindForm.localWorkspaceId),
  });
  if (!result.ok) {
    message.error(result.message || "绑定 Host 失败");
    return;
  }
  message.success("Host 已绑定并进入在线状态");
  hostBindOpen.value = false;
}

/** 二次确认后取消 Host 绑定，失败时保持错误态可见。 */
function confirmUnbindHost(record: SharedWorkspaceListItem): void {
  Modal.confirm({
    title: "取消绑定 Host",
    content: `确认取消「${record.name}」的 Host 绑定？取消后成员将无法进入共享工作区，Host 本地资料不会删除。`,
    okText: "确认取消绑定",
    cancelText: "再想想",
    okType: "danger",
    async onOk() {
      const result = await sharedWorkspaces.unbindHost(record.id);
      if (!result.ok) {
        message.error(result.message || "取消绑定 Host 失败");
        throw new Error(result.message || "取消绑定 Host 失败");
      }
      message.success(result.message || "Host 绑定已取消");
    },
  });
}

async function openMembers(record: SharedWorkspaceListItem): Promise<void> {
  sharedWorkspaces.setSelectedWorkspace(record.id);
  membersOpen.value = true;
  memberDrawerTab.value = "members";
  inviteUserIds.value = [];
  candidateSearch.value = "";
  includeUnavailable.value = false;
  await Promise.all([
    sharedWorkspaces.loadMembers(record.id),
    sharedWorkspaces.loadAssetMaintenancePolicy(record.id),
    sharedWorkspaces.loadFileTransferPolicy(record.id),
    sharedWorkspaces.loadFileTransfers(record.id, transferQuery.value),
  ]);
  applyAssetMaintenancePolicyToForm(selectedAssetMaintenancePolicy.value);
  applyTransferPolicyToForm(selectedTransferPolicy.value);
  if (record.currentUserRole === "workspace_admin") {
    await sharedWorkspaces.loadInviteCandidates(record.id, candidateSearch.value);
  }
}

/** 保存传输策略，并用服务端返回的生效策略回填表单。 */
async function saveTransferPolicy(): Promise<void> {
  if (!selectedWorkspaceId.value) return;
  const result = await sharedWorkspaces.updateFileTransferPolicy(selectedWorkspaceId.value, { ...transferPolicyForm });
  if (!result.ok) {
    message.error(result.message || "保存文件传输策略失败");
    return;
  }
  applyTransferPolicyToForm(result.policy);
  message.success("文件传输策略已保存");
}

/** 保存资产维护策略，并刷新共享入口能力快照。 */
async function saveAssetMaintenancePolicy(): Promise<void> {
  if (!selectedWorkspaceId.value) return;
  const result = await sharedWorkspaces.updateAssetMaintenancePolicy(selectedWorkspaceId.value, {
    ...assetMaintenancePolicyForm,
    authorizedMemberUserIds: [...assetMaintenancePolicyForm.authorizedMemberUserIds],
  });
  if (!result.ok) {
    message.error(result.message || "保存资产维护策略失败");
    return;
  }
  applyAssetMaintenancePolicyToForm(result.policy);
  await loadList();
  message.success("资产维护策略已保存");
}

async function refreshTransferEvents(): Promise<void> {
  if (!selectedWorkspaceId.value) return;
  const result = await sharedWorkspaces.loadFileTransfers(selectedWorkspaceId.value, transferQuery.value);
  if (!result.ok) message.error(result.message || "传输明细加载失败");
}

function resetTransferFilters(): void {
  transferDirectionFilter.value = undefined;
  transferStatusFilter.value = undefined;
  transferKeyword.value = "";
  void refreshTransferEvents();
}

async function refreshInviteCandidates(): Promise<void> {
  if (!selectedWorkspaceId.value) return;
  const result = await sharedWorkspaces.loadInviteCandidates(selectedWorkspaceId.value, candidateSearch.value);
  if (!result.ok) message.error(result.message || "邀请候选加载失败");
}

async function submitInvite(): Promise<void> {
  if (!selectedWorkspaceId.value || !inviteUserIds.value.length) return;
  const result = await sharedWorkspaces.inviteMembers(selectedWorkspaceId.value, {
    userIds: inviteUserIds.value,
  });
  if (!result.ok) {
    message.error(result.message || "邀请成员失败");
    return;
  }
  message.success(`已邀请 ${result.invited.length} 位成员，邀请立即生效`);
  inviteUserIds.value = [];
}

/** 二次确认后移除普通成员，保留 Host 本地资料和历史成员记录。 */
function confirmRemoveMember(record: SharedWorkspaceMemberItem): void {
  const workspaceId = selectedWorkspaceId.value;
  if (!workspaceId || !canRemoveMember(record)) return;
  const memberName = record.displayName || record.email || record.userId;
  Modal.confirm({
    title: "移除成员",
    content: `确认将「${memberName}」移出该共享工作区？移除后对方将无法进入共享工作区。`,
    okText: "确认移除",
    cancelText: "取消",
    okType: "danger",
    async onOk() {
      const result = await sharedWorkspaces.removeMember(workspaceId, record.id);
      if (!result.ok) {
        message.error(result.message || "移除成员失败");
        throw new Error(result.message || "移除成员失败");
      }
      message.success("成员已移除");
    },
  });
}

async function leaveSelectedWorkspace(): Promise<void> {
  if (!selectedWorkspace.value) return;
  Modal.confirm({
    title: "退出共享工作区",
    content: "退出后将无法进入该共享工作区，不影响 Host 本机资料。",
    okText: "确认退出",
    cancelText: "取消",
    onOk: async () => {
      const result = await sharedWorkspaces.leave(selectedWorkspace.value!.id);
      if (!result.ok) {
        message.error(result.message || "退出共享工作区失败");
        return;
      }
      message.success("已退出共享工作区");
      membersOpen.value = false;
    },
  });
}

/** 确认删除共享关系；只删除共享定义，不删除 Host 本地资料。 */
function confirmDelete(record: SharedWorkspaceListItem): void {
  Modal.confirm({
    title: "删除共享关系",
    content: `将删除「${record.name}」的共享关系和成员入口，但不会删除工作区管理员本机资料。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      const result = await sharedWorkspaces.deleteWorkspace(record.id, buildListQuery(record.enterpriseId) ?? undefined);
      if (!result.ok) {
        message.error(result.message || "删除共享工作区失败");
        return;
      }
      message.success(result.message);
    },
  });
}

watch(
  [managedEnterpriseId, canCreate],
  async ([enterpriseId]) => {
    sharedWorkspaces.setSelectedWorkspace(null);
    createForm.workspaceAdminUserId = "";
    if (!enterpriseId) {
      enterpriseMembersLoadRevision += 1;
      enterpriseSummaryLoading.value = false;
      enterpriseSummaryError.value = "";
      return;
    }
    await Promise.all([loadEnterpriseMembers(false), loadList()]);
  },
  { immediate: true },
);

onMounted(() => { void loadList(); });

onBeforeUnmount(() => {
  if (candidateSearchTimer) clearTimeout(candidateSearchTimer);
});
</script>

<template>
  <div class="shared-workspace-panel">
    <div class="shared-workspace-panel__hero">
      <div>
        <h3>共享工作区</h3>
        <p>共享工作区可让企业内部用户实时访问同一份知识库和项目代码，在工作流中相互协同完成复杂需求开发，且可控制资产库权限和安全。</p>
      </div>
      <div class="shared-workspace-panel__hero-stats">
        <div class="shared-workspace-panel__hero-stat">
          <a-statistic title="共享工作区" :value="sharedWorkspaces.total" />
        </div>
        <div class="shared-workspace-panel__hero-stat">
          <a-statistic title="Host 在线" :value="sharedWorkspaces.items.filter((item) => item.hostStatus === 'online').length" />
        </div>
        <div class="shared-workspace-panel__hero-stat">
          <a-statistic title="待绑定" :value="sharedWorkspaces.items.filter((item) => item.hostStatus === 'unbound').length" />
        </div>
      </div>
    </div>

    <div class="shared-workspace-panel__toolbar">
      <a-input v-model:value="keyword" class="shared-workspace-panel__search" allow-clear placeholder="搜索名称、管理员、执行主机工作区" />
      <a-select v-model:value="hostStatusFilter" class="shared-workspace-panel__status-select" allow-clear placeholder="Host 状态" @change="loadList">
        <a-select-option value="unbound">待绑定 Host</a-select-option>
        <a-select-option value="online">Host 在线</a-select-option>
        <a-select-option value="offline">Host 离线</a-select-option>
      </a-select>
      <a-button :loading="sharedWorkspaces.loading || enterpriseSummaryLoading" @click="refreshPanel">刷新</a-button>
      <a-button type="primary" :disabled="!canCreate" @click="openCreate">新建共享工作区</a-button>
    </div>

    <a-alert
      v-if="!managedEnterpriseId"
      type="info"
      show-icon
      message="当前账号不在企业中，无法使用共享工作区"
    />
    <a-alert
      v-else-if="!managedEnterpriseId"
      type="warning"
      show-icon
      message="当前账号不在企业中，无法使用共享工作区"
    />

    <a-table
      v-else
      row-key="id"
      :columns="tableColumns"
      :data-source="filteredItems"
      :loading="sharedWorkspaces.loading"
      :pagination="{ pageSize: 20 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="shared-workspace-panel__space-name">
            <strong>{{ record.name }}</strong>
            <span>{{ record.description || "无说明" }}</span>
            <span class="shared-workspace-panel__space-meta">
              创建时间 {{ formatCreatedAt(record.createdAt) }}
            </span>
          </div>
        </template>
        <template v-else-if="column.key === 'current'">
          <div class="shared-workspace-panel__current">
            <a-tag :color="hostStatusColor(record.hostStatus)">{{ hostStatusLabel(record.hostStatus) }}</a-tag>
            <span>{{ record.memberCount }} 位成员</span>
            <span>{{ record.host?.localWorkspaceLabel || record.host?.localWorkspaceId || "未绑定本地工作区" }}</span>
          </div>
        </template>
        <template v-else-if="column.key === 'admin'">
          <div class="shared-workspace-panel__admin">
            <strong>{{ record.workspaceAdminName || record.workspaceAdminUserId }}</strong>
            <span>{{ record.workspaceAdminEmail || "-" }}</span>
          </div>
        </template>
        <template v-else-if="column.key === 'actions'">
          <div class="shared-workspace-panel__row-actions">
            <a-button v-if="canManageEnterpriseWorkspace(record)" type="link" size="small" @click="openEdit(record)">编辑</a-button>
            <a-button type="link" size="small" @click="openMembers(record)">工作区管理</a-button>
            <a-button
              type="link"
              size="small"
              :danger="isHostBound(record)"
              :disabled="isHostBound(record) ? !canUnbindHost(record) : !canBindHost(record)"
              @click="isHostBound(record) ? confirmUnbindHost(record) : openHostBind(record)"
            >
              {{ isHostBound(record) ? "取消绑定" : "绑定 Host" }}
            </a-button>
            <a-button v-if="canManageRow(record)" type="link" size="small" danger @click="confirmDelete(record)">
              删除
            </a-button>
          </div>
        </template>
      </template>
    </a-table>

    <a-modal v-model:open="createOpen" title="新建共享工作区" :confirm-loading="sharedWorkspaces.saving" ok-text="创建" @ok="submitCreate">
      <a-form layout="vertical" autocomplete="off">
        <a-form-item label="工作区名称">
          <a-input
            v-model:value="createForm.name"
            name="codeflow-shared-workspace-name"
            autocomplete="new-password"
            placeholder="例如：交付平台共享工作区"
          />
        </a-form-item>
        <a-form-item label="工作区管理员">
          <a-select v-model:value="createForm.workspaceAdminUserId" show-search :loading="enterpriseSummaryLoading" placeholder="选择同企业有效成员">
            <a-select-option v-for="item in workspaceAdminOptions" :key="item.value" :value="item.value" :disabled="item.disabled">
              {{ item.label }} / {{ item.email }} <span v-if="item.hint">（{{ item.hint }}）</span>
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="说明">
          <a-textarea v-model:value="createForm.description" :rows="3" placeholder="说明共享边界、用途或项目背景" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="editOpen" title="编辑共享工作区" :confirm-loading="sharedWorkspaces.saving" ok-text="保存" @ok="submitEdit">
      <a-form layout="vertical" autocomplete="off">
        <a-form-item label="工作区名称">
          <a-input
            v-model:value="editForm.name"
            name="codeflow-shared-workspace-edit-name"
            autocomplete="new-password"
            placeholder="请输入 2-50 个字符"
            :maxlength="50"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="hostBindOpen" title="绑定执行主机" :confirm-loading="sharedWorkspaces.saving" ok-text="绑定" @ok="submitHostBind">
      <a-alert
        type="info"
        show-icon
        message="当前只允许工作区管理员绑定自己的在线本地端；绑定后共享工作区内的资料读取、流程使用和维护动作都会经 Server 鉴权后路由到该执行主机。"
      />
      <a-form class="shared-workspace-panel__modal-form" layout="vertical">
        <a-form-item label="执行主机 / 本地工作区">
          <a-select
            :value="hostBindForm.hostClientId && hostBindForm.localWorkspaceId ? `${hostBindForm.hostClientId}::${hostBindForm.localWorkspaceId}` : undefined"
            placeholder="选择当前账号在线本地端承载的本地工作区"
            option-label-prop="label"
            @change="handleHostWorkspaceSelect"
          >
            <a-select-option v-for="item in hostWorkspaceOptions" :key="item.value" :value="item.value" :label="item.label">
              <div class="shared-workspace-panel__host-option" :title="`${item.label} / ${item.pathLabel}`">
                <span class="shared-workspace-panel__host-option-title">{{ item.label }}</span>
                <span class="shared-workspace-panel__host-option-meta">{{ item.pathLabel }}</span>
                <span class="shared-workspace-panel__host-option-client">{{ item.clientLabel }}</span>
              </div>
            </a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
      <a-empty v-if="!hostWorkspaceOptions.length" description="当前账号没有可绑定的在线执行主机，请先启动 CodeFlow 本地端" />
    </a-modal>

    <a-drawer
      v-model:open="membersOpen"
      width="min(920px, calc(100vw - 24px))"
      :title="selectedWorkspace ? `成员与邀请 · ${selectedWorkspace.name}` : '成员与邀请'"
      destroy-on-close
      class="shared-workspace-panel__member-drawer"
    >
      <div v-if="selectedWorkspace" class="shared-workspace-panel__members">
        <a-tabs v-model:activeKey="memberDrawerTab" class="shared-workspace-panel__member-tabs">
          <a-tab-pane key="members">
            <template #tab>
              <span class="shared-workspace-panel__tab-label">
                现有成员
                <a-tag class="shared-workspace-panel__tab-count">{{ selectedMembers.length }}</a-tag>
              </span>
            </template>
            <a-table
              row-key="id"
              size="small"
              :columns="memberColumns"
              :data-source="selectedMembers"
              :pagination="false"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'member'">
                  <strong>{{ record.displayName }}</strong>
                  <div class="shared-workspace-panel__muted">{{ record.email }}</div>
                </template>
                <template v-else-if="column.key === 'role'">
                  <a-tag>{{ roleLabel(record.role) }}</a-tag>
                </template>
                <template v-else-if="column.key === 'status'">
                  <a-tag :color="record.status === 'active' ? 'blue' : 'default'">{{ record.status === "active" ? "在空间内" : "已退出" }}</a-tag>
                </template>
                <template v-else-if="column.key === 'actions'">
                  <a-button
                    v-if="canRemoveMember(record)"
                    type="link"
                    size="small"
                    danger
                    :loading="sharedWorkspaces.saving"
                    @click="confirmRemoveMember(record)"
                  >
                    移除
                  </a-button>
                </template>
              </template>
            </a-table>
          </a-tab-pane>

          <a-tab-pane
            v-if="selectedWorkspace.currentUserRole === 'workspace_admin'"
            key="invite"
            tab="邀请新成员"
          >
            <div class="shared-workspace-panel__invite">
              <div class="shared-workspace-panel__invite-toolbar">
                <a-input
                  v-model:value="candidateSearch"
                  allow-clear
                  placeholder="搜索同企业成员姓名或邮箱"
                  class="shared-workspace-panel__invite-search"
                  @input="onCandidateSearchInput"
                />
                <a-button
                  type="primary"
                  :disabled="!inviteUserIds.length"
                  :loading="sharedWorkspaces.saving"
                  @click="submitInvite"
                >
                  邀请已选 {{ inviteUserIds.length }} 人
                </a-button>
              </div>
              <div class="shared-workspace-panel__invite-filter">
                <a-checkbox
                  v-model:checked="includeUnavailable"
                  class="shared-workspace-panel__invite-toggle"
                >
                  同时显示不可邀请的人（{{ selectedInviteCandidates.unavailable.length }} 人）
                </a-checkbox>
              </div>
              <a-empty
                v-if="!visibleInviteCandidates.length"
                :description="includeUnavailable ? '没有匹配的候选人，可调整搜索词。' : '没有可邀请的候选人，可勾选上方查看不可邀请的人。'"
              />
              <a-table
                v-else
                row-key="userId"
                size="small"
                :columns="inviteCandidateColumns"
                :data-source="visibleInviteCandidates"
                :row-selection="inviteRowSelection"
                :pagination="{ pageSize: 20, hideOnSinglePage: true }"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'candidate'">
                    <strong>{{ record.displayName }}</strong>
                    <div class="shared-workspace-panel__muted">{{ record.email }}</div>
                  </template>
                  <template v-else-if="column.key === 'eligible'">
                    <a-tag v-if="record.eligible" color="green">可邀请</a-tag>
                    <a-tag v-else color="default">{{ disabledReasonLabel(record.disabledReason) }}</a-tag>
                  </template>
                </template>
              </a-table>
            </div>
          </a-tab-pane>

          <a-tab-pane key="assetMaintenance" tab="资产权限">
            <div class="shared-workspace-panel__asset-policy">
              <a-alert
                type="info"
                show-icon
                message="企业管理员和工作区管理员默认可维护共享资产；普通成员可按全员编辑或指定成员编辑获得维护权限。"
              />
              <a-form class="shared-workspace-panel__transfer-form" layout="vertical">
                <a-form-item label="维护模式">
                  <div class="shared-workspace-panel__asset-mode-grid">
                    <button
                      type="button"
                      class="shared-workspace-panel__asset-mode"
                      :class="{ 'shared-workspace-panel__asset-mode--active': assetMaintenancePolicyForm.mode === 'all_members' }"
                      :disabled="!canManageSelectedAssetMaintenance"
                      @click="setAssetMaintenanceMode('all_members')"
                    >
                      <span class="shared-workspace-panel__asset-mode-title">全员编辑</span>
                      <span class="shared-workspace-panel__asset-mode-desc">所有有效普通成员都可维护共享资产定义。</span>
                    </button>
                    <button
                      type="button"
                      class="shared-workspace-panel__asset-mode"
                      :class="{ 'shared-workspace-panel__asset-mode--active': assetMaintenancePolicyForm.mode === 'selected_members' }"
                      :disabled="!canManageSelectedAssetMaintenance"
                      @click="setAssetMaintenanceMode('selected_members')"
                    >
                      <span class="shared-workspace-panel__asset-mode-title">指定成员编辑</span>
                      <span class="shared-workspace-panel__asset-mode-desc">仅名单内有效普通成员可维护，其他成员仍可使用资产。</span>
                    </button>
                  </div>
                </a-form-item>

                <div
                  v-if="assetMaintenancePolicyForm.mode === 'selected_members'"
                  class="shared-workspace-panel__maintainers"
                >
                  <div class="shared-workspace-panel__maintainer-section">
                    <div class="shared-workspace-panel__section-head">
                      <strong>已授权维护成员</strong>
                      <span class="shared-workspace-panel__muted">{{ assetMaintainerRows.length }} 人</span>
                    </div>
                    <a-alert
                      v-if="assetMaintainerRows.length === 0"
                      type="warning"
                      show-icon
                      message="当前未指定普通成员编辑共享资产。普通成员仍可读取和使用共享资产，但不能维护资产定义。"
                    />
                    <div v-else class="shared-workspace-panel__maintainer-list">
                      <div
                        v-for="member in assetMaintainerRows"
                        :key="member.userId"
                        class="shared-workspace-panel__maintainer-row"
                      >
                        <div class="shared-workspace-panel__maintainer-main">
                          <strong>{{ member.displayName }}</strong>
                          <span>{{ member.email || member.userId }}</span>
                        </div>
                        <a-tag v-if="member.effective" color="green">可维护</a-tag>
                        <a-tag v-else color="default">{{ assetMaintainerDisabledReasonLabel(member.disabledReason) }}</a-tag>
                        <a-button
                          size="small"
                          danger
                          :disabled="!canManageSelectedAssetMaintenance"
                          @click="removeAssetMaintainer(member.userId)"
                        >
                          移除
                        </a-button>
                      </div>
                    </div>
                  </div>

                  <div class="shared-workspace-panel__maintainer-section">
                    <div class="shared-workspace-panel__section-head">
                      <strong>添加成员</strong>
                      <span class="shared-workspace-panel__muted">仅显示有效普通成员</span>
                    </div>
                    <a-input
                      v-model:value="assetMaintainerSearch"
                      placeholder="搜索成员..."
                      allow-clear
                      :disabled="!canManageSelectedAssetMaintenance"
                    />
                    <a-empty
                      v-if="assetMaintainerCandidates.length === 0"
                      description="没有可添加的成员"
                      :image="false"
                    />
                    <div v-else class="shared-workspace-panel__maintainer-list">
                      <div
                        v-for="member in assetMaintainerCandidates"
                        :key="member.userId"
                        class="shared-workspace-panel__maintainer-row"
                      >
                        <div class="shared-workspace-panel__maintainer-main">
                          <strong>{{ member.displayName }}</strong>
                          <span>{{ member.email || member.userId }}</span>
                        </div>
                        <a-button
                          type="link"
                          size="small"
                          :disabled="!canManageSelectedAssetMaintenance"
                          @click="addAssetMaintainer(member.userId)"
                        >
                          添加
                        </a-button>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="shared-workspace-panel__transfer-actions">
                  <span class="shared-workspace-panel__muted">
                    当前状态：{{ assetMaintenancePolicyForm.mode === "all_members" ? "全员编辑" : `指定成员编辑 · ${assetMaintainerRows.filter((item) => item.effective).length} 人生效` }}
                  </span>
                  <a-button
                    type="primary"
                    :disabled="!canManageSelectedAssetMaintenance"
                    :loading="sharedWorkspaces.saving"
                    @click="saveAssetMaintenancePolicy"
                  >
                    保存策略
                  </a-button>
                </div>
              </a-form>
            </div>
          </a-tab-pane>

          <a-tab-pane key="fileTransfer" tab="文件传输">
            <div class="shared-workspace-panel__transfer">
              <a-alert
                type="info"
                show-icon
                message="上传和下载只支持单文件；权限关闭时成员无法传输文件，拒绝记录会写入传输明细。"
              />
              <a-form class="shared-workspace-panel__transfer-form" layout="vertical">
                <div class="shared-workspace-panel__transfer-switches">
                  <a-form-item label="上传权限">
                    <a-switch v-model:checked="transferPolicyForm.uploadEnabled" :disabled="!canManageSelectedTransfer" />
                  </a-form-item>
                  <a-form-item label="下载权限">
                    <a-switch v-model:checked="transferPolicyForm.downloadEnabled" :disabled="!canManageSelectedTransfer" />
                  </a-form-item>
                </div>
                <div class="shared-workspace-panel__transfer-grid">
                  <a-form-item label="单文件上限（MB）">
                    <a-input-number v-model:value="transferMaxFileSizeMib" :min="0.001" :precision="3" :step="10" addon-after="MB" :disabled="!canManageSelectedTransfer" style="width: 100%" />
                  </a-form-item>
                  <a-form-item label="上传限速（MB/s）">
                    <a-input-number v-model:value="transferUploadRateMib" :min="0.001" :precision="3" :step="1" addon-after="MB/s" :disabled="!canManageSelectedTransfer" style="width: 100%" />
                  </a-form-item>
                  <a-form-item label="下载限速（MB/s）">
                    <a-input-number v-model:value="transferDownloadRateMib" :min="0.001" :precision="3" :step="1" addon-after="MB/s" :disabled="!canManageSelectedTransfer" style="width: 100%" />
                  </a-form-item>
                  <a-form-item label="并发数">
                    <a-input-number v-model:value="transferPolicyForm.maxConcurrentTransfers" :min="1" :max="20" :disabled="!canManageSelectedTransfer" style="width: 100%" />
                  </a-form-item>
                </div>
                <div class="shared-workspace-panel__transfer-actions">
                  <span class="shared-workspace-panel__muted">
                    当前上限 {{ formatBytes(transferPolicyForm.maxFileSizeBytes) }}，上传限速 {{ formatBytes(transferPolicyForm.uploadRateLimitBytesPerSecond) }}/s，下载限速 {{ formatBytes(transferPolicyForm.downloadRateLimitBytesPerSecond) }}/s
                  </span>
                  <a-button @click="refreshTransferEvents">刷新明细</a-button>
                  <a-button type="primary" :disabled="!canManageSelectedTransfer" :loading="sharedWorkspaces.saving" @click="saveTransferPolicy">保存策略</a-button>
                </div>
              </a-form>
              <div class="shared-workspace-panel__transfer-filters">
                <a-select
                  v-model:value="transferDirectionFilter"
                  allow-clear
                  placeholder="方向"
                  style="width: 120px"
                  @change="refreshTransferEvents"
                >
                  <a-select-option value="upload">上传</a-select-option>
                  <a-select-option value="download">下载</a-select-option>
                </a-select>
                <a-select
                  v-model:value="transferStatusFilter"
                  allow-clear
                  placeholder="状态"
                  style="width: 140px"
                  @change="refreshTransferEvents"
                >
                  <a-select-option value="pending">等待</a-select-option>
                  <a-select-option value="running">传输中</a-select-option>
                  <a-select-option value="succeeded">成功</a-select-option>
                  <a-select-option value="failed">失败</a-select-option>
                  <a-select-option value="cancelled">已取消</a-select-option>
                  <a-select-option value="rejected">已拒绝</a-select-option>
                </a-select>
                <a-input-search
                  v-model:value="transferKeyword"
                  class="shared-workspace-panel__transfer-search"
                  placeholder="搜索文件、路径、错误码"
                  allow-clear
                  @search="refreshTransferEvents"
                />
                <a-button @click="resetTransferFilters">重置</a-button>
              </div>
              <a-table
                row-key="id"
                size="small"
                :columns="transferColumns"
                :data-source="selectedTransferEvents.items"
                :pagination="{ pageSize: 20, hideOnSinglePage: true }"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'file'">
                    <strong class="shared-workspace-panel__transfer-file" :title="record.filePath">{{ record.fileName }}</strong>
                    <div class="shared-workspace-panel__muted">{{ record.filePath }} · {{ formatBytes(record.transferredBytes) }} / {{ formatBytes(record.sizeBytes) }}</div>
                    <div v-if="record.errorMessage" class="shared-workspace-panel__transfer-error">{{ record.errorMessage }}</div>
                  </template>
                  <template v-else-if="column.key === 'direction'">
                    {{ transferDirectionLabel(record.direction) }}
                  </template>
                  <template v-else-if="column.key === 'status'">
                    <a-tag :color="transferStatusColor(record.status)">{{ transferStatusLabel(record.status) }}</a-tag>
                  </template>
                  <template v-else-if="column.key === 'actor'">
                    <span :title="record.actorEmail || record.actorUserId">{{ record.actorDisplayName || record.actorUserId }}</span>
                  </template>
                  <template v-else-if="column.key === 'time'">
                    {{ formatDateTime(record.createdAt) }}
                  </template>
                </template>
              </a-table>
            </div>
          </a-tab-pane>
        </a-tabs>
      </div>

      <template #footer>
        <div class="shared-workspace-panel__drawer-footer">
          <a-button
            v-if="selectedWorkspace?.currentUserRole === 'member'"
            danger
            @click="leaveSelectedWorkspace"
          >
            退出共享工作区
          </a-button>
          <span class="shared-workspace-panel__drawer-footer-spacer" />
          <span class="shared-workspace-panel__drawer-footer-hint">邀请即时生效；管理员暂不可主动退出。</span>
          <a-button @click="membersOpen = false">关闭</a-button>
        </div>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.shared-workspace-panel {
  display: grid;
  align-content: start;
  gap: 16px;
  min-width: 0;
}

.shared-workspace-panel__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 20px;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel-bg);
}

.shared-workspace-panel__hero h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--app-text);
}

.shared-workspace-panel__hero p {
  margin: 0;
  color: var(--app-muted);
}

.shared-workspace-panel__hero-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(84px, 1fr));
  align-items: stretch;
  flex: 0 0 auto;
  min-width: 320px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-bg);
}

.shared-workspace-panel__hero-stat {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 76px;
  padding: 8px 14px;
  text-align: center;
}

.shared-workspace-panel__hero-stat + .shared-workspace-panel__hero-stat {
  border-left: 1px solid var(--app-border);
}

.shared-workspace-panel__hero-stat :deep(.ant-statistic) {
  display: grid;
  gap: 8px;
  justify-items: center;
}

.shared-workspace-panel__hero-stat :deep(.ant-statistic-title) {
  margin: 0;
  color: var(--app-muted);
  line-height: 1.2;
  white-space: nowrap;
}

.shared-workspace-panel__hero-stat :deep(.ant-statistic-content) {
  color: var(--app-text);
  font-size: 24px;
  line-height: 1;
}

.shared-workspace-panel__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.shared-workspace-panel__enterprise-select {
  min-width: 280px;
}

.shared-workspace-panel__search {
  flex: 1 1 260px;
  min-width: min(100%, 220px);
}

.shared-workspace-panel__status-select {
  width: 160px;
}

.shared-workspace-panel__space-name,
.shared-workspace-panel__admin,
.shared-workspace-panel__current {
  display: grid;
  gap: 4px;
}

.shared-workspace-panel__space-name span,
.shared-workspace-panel__admin span,
.shared-workspace-panel__current span,
.shared-workspace-panel__muted {
  color: var(--app-muted);
  font-size: 12px;
}

.shared-workspace-panel__space-meta {
  font-size: 11px;
  color: color-mix(in srgb, var(--app-muted) 80%, transparent);
}

.shared-workspace-panel__modal-form,
.shared-workspace-panel__members,
.shared-workspace-panel__invite,
.shared-workspace-panel__asset-policy,
.shared-workspace-panel__transfer {
  display: grid;
  gap: 14px;
}

.shared-workspace-panel__modal-form :deep(.ant-select-selection-item) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shared-workspace-panel__host-option {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
}

.shared-workspace-panel__host-option-title,
.shared-workspace-panel__host-option-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shared-workspace-panel__host-option-title {
  font-weight: 600;
  color: var(--app-text);
}

.shared-workspace-panel__host-option-meta {
  grid-column: 1 / 2;
  font-size: 12px;
  color: var(--app-muted);
}

.shared-workspace-panel__host-option-client {
  grid-column: 2 / 3;
  grid-row: 1 / 3;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-muted);
}

.shared-workspace-panel__row-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
  white-space: nowrap;
}

.shared-workspace-panel__row-actions :deep(.ant-btn-link) {
  padding-inline: 6px;
}

.shared-workspace-panel__row-more {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-muted);
}

.shared-workspace-panel__row-more:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-text) 6%, transparent);
}

.shared-workspace-panel__member-tabs {
  margin-top: -8px;
}

.shared-workspace-panel__tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.shared-workspace-panel__tab-count {
  margin: 0;
  padding: 0 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--app-muted);
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  border: none;
}

.shared-workspace-panel__invite-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.shared-workspace-panel__invite-search {
  flex: 1 1 auto;
  min-width: 0;
}

.shared-workspace-panel__invite-filter {
  display: flex;
  justify-content: flex-end;
  margin-top: -4px;
}

.shared-workspace-panel__transfer-form {
  display: grid;
  gap: 12px;
}

.shared-workspace-panel__asset-mode-grid,
.shared-workspace-panel__maintainers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.shared-workspace-panel__asset-mode {
  display: grid;
  gap: 6px;
  min-height: 86px;
  padding: 14px;
  text-align: left;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  cursor: pointer;
}

.shared-workspace-panel__asset-mode:disabled {
  cursor: not-allowed;
  opacity: 0.64;
}

.shared-workspace-panel__asset-mode--active {
  border-color: #1677ff;
  box-shadow: inset 0 0 0 1px #1677ff;
}

.shared-workspace-panel__asset-mode-title {
  color: var(--app-text);
  font-weight: 600;
}

.shared-workspace-panel__asset-mode-desc {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.shared-workspace-panel__maintainer-section {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-surface) 92%, var(--app-text) 2%);
}

.shared-workspace-panel__section-head,
.shared-workspace-panel__maintainer-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shared-workspace-panel__section-head {
  justify-content: space-between;
}

.shared-workspace-panel__maintainer-list {
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow: auto;
}

.shared-workspace-panel__maintainer-row {
  min-height: 46px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: 6px;
  background: var(--app-surface);
}

.shared-workspace-panel__maintainer-main {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
}

.shared-workspace-panel__maintainer-main strong,
.shared-workspace-panel__maintainer-main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shared-workspace-panel__maintainer-main span {
  color: var(--app-muted);
  font-size: 12px;
}

.shared-workspace-panel__transfer-switches,
.shared-workspace-panel__transfer-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.shared-workspace-panel__transfer-switches :deep(.ant-form-item),
.shared-workspace-panel__transfer-grid :deep(.ant-form-item) {
  margin-bottom: 0;
}

.shared-workspace-panel__transfer-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.shared-workspace-panel__transfer-actions {
  justify-content: flex-end;
}

.shared-workspace-panel__transfer-actions .shared-workspace-panel__muted {
  flex: 1 1 180px;
}

.shared-workspace-panel__transfer-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.shared-workspace-panel__transfer-search {
  flex: 1 1 220px;
  min-width: min(100%, 180px);
}

.shared-workspace-panel__transfer-file {
  display: block;
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shared-workspace-panel__transfer-error {
  margin-top: 2px;
  color: #cf1322;
  font-size: 12px;
}

.shared-workspace-panel__invite-toggle {
  color: var(--app-muted);
  font-size: 12px;
}

.shared-workspace-panel__drawer-footer {
  display: flex;
  align-items: center;
  gap: 12px;
}

.shared-workspace-panel__drawer-footer-spacer {
  flex: 1 1 auto;
}

.shared-workspace-panel__drawer-footer-hint {
  font-size: 12px;
  color: var(--app-muted);
}

@media (max-width: 900px) {
  .shared-workspace-panel__hero {
    flex-direction: column;
    align-items: stretch;
  }

  .shared-workspace-panel__hero-stats {
    min-width: 0;
  }

  .shared-workspace-panel__enterprise-select,
  .shared-workspace-panel__status-select {
    width: 100%;
  }

  .shared-workspace-panel__invite-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .shared-workspace-panel__transfer-grid {
    grid-template-columns: 1fr;
  }

  .shared-workspace-panel__asset-mode-grid,
  .shared-workspace-panel__maintainers {
    grid-template-columns: 1fr;
  }

  .shared-workspace-panel__drawer-footer-hint {
    display: none;
  }
}
</style>
