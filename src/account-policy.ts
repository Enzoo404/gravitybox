export interface ValidatedPolicyPatch {
    enabled?: boolean;
    strategy?: 'priority' | 'round_robin';
    monitored_model?: string;
    candidate_account_ids?: string[];
    last_switched_id?: string | null;
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
    if (data.last_switched_id !== undefined && data.last_switched_id !== null && (typeof data.last_switched_id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(data.last_switched_id)))
        throw Error('推荐游标无效');
    for (const key of ['reserve_percentage', 'reservePercentage', 'candidate_min_percentage', 'candidateMinPercentage']) {
        if (data[key] !== undefined && (typeof data[key] !== 'number' || !Number.isFinite(data[key])))
            throw Error('配额门槛必须为有限数值');
    }
}
