export interface ValidatedPolicyPatch {
    enabled?: boolean;
    strategy?: 'priority' | 'round_robin';
    monitored_model?: string;
    candidate_account_ids?: string[];
    last_switched_id?: string;
    reserve_percentage?: number;
    reservePercentage?: number;
    candidate_min_percentage?: number;
    candidateMinPercentage?: number;
}
/** Validate dynamic IPC/config input before it can reach the recommendation engine. */
export function validateAccountPolicy(value: unknown): asserts value is ValidatedPolicyPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('账号推荐配置格式无效');
    const data = value as Record<string, unknown>;
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean')
        throw Error('推荐开关必须为布尔值');
    if (data.strategy !== undefined && (typeof data.strategy !== 'string' || !['priority', 'round_robin'].includes(data.strategy)))
        throw Error('推荐策略无效');
    if (data.monitored_model !== undefined && (typeof data.monitored_model !== 'string' || !data.monitored_model.trim() || data.monitored_model.length > 120 || /[\x00-\x1f]/.test(data.monitored_model)))
        throw Error('监控模型名称无效');
    if (data.candidate_account_ids !== undefined && (!Array.isArray(data.candidate_account_ids) || data.candidate_account_ids.length > 200 || data.candidate_account_ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) || new Set(data.candidate_account_ids).size !== data.candidate_account_ids.length))
        throw Error('候选账号必须是有效且不重复的账号ID列表（最多200个）');
    if (data.last_switched_id !== undefined && (typeof data.last_switched_id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(data.last_switched_id)))
        throw Error('推荐游标无效');
    for (const key of ['reserve_percentage', 'reservePercentage', 'candidate_min_percentage', 'candidateMinPercentage']) {
        if (data[key] !== undefined && (typeof data[key] !== 'number' || !Number.isFinite(data[key])))
            throw Error('配额门槛必须为有限数值');
    }
}
export function validateAccountImport(value: unknown): asserts value is {
    accounts: Array<Record<string, any>>;
} {
    if (!value || typeof value !== 'object' || !Array.isArray((value as any).accounts) || (value as any).accounts.length > 1000)
        throw Error('账号导入列表无效或超过1000项');
    if ((value as any).schema_version !== undefined && ![1, 2].includes((value as any).schema_version))
        throw Error('账号备份版本不支持；未开始导入');
    if ((value as any).tokens_included !== undefined && typeof (value as any).tokens_included !== 'boolean')
        throw Error('账号备份凭据标识无效');
    for (const [index, item] of (value as any).accounts.entries()) {
        if (item && typeof item === 'object') {
            for (const key of ['oauth_client_key', 'project_id']) {
                if (item[key] !== undefined && item[key] !== null && (typeof item[key] !== 'string' || item[key].length > 256 || /[\x00-\x1f]/.test(item[key]))) throw Error(`第${index + 1}条账号元数据无效；未开始导入`);
            }
            if (item.is_gcp_tos !== undefined && typeof item.is_gcp_tos !== 'boolean') throw Error(`第${index + 1}条账号许可标识无效；未开始导入`);
        }
        if (!item || typeof item !== 'object' || typeof item.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(item.email) || item.email.length > 254
            || typeof item.refresh_token !== 'string' || !item.refresh_token.trim() || item.refresh_token.length > 8192 || /[\r\n\x00]/.test(item.refresh_token)
            || item.name !== undefined && item.name !== null && (typeof item.name !== 'string' || item.name.length > 80)
            || item.custom_label !== undefined && item.custom_label !== null && (typeof item.custom_label !== 'string' || item.custom_label.length > 256))
            throw Error(`第${index + 1}条账号记录格式无效；未开始导入`);
    }
}
