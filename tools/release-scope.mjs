/**
 * 发布验证范围（release scope）的纯解析/校验模块。
 *
 * 背景：用户明确选择“仅针对当前 2.24.0 定向发布”，保留 2.23.x 代码但如实声明本轮未重新验证；
 * 这不是把缺源版本当作通过。verify 默认仍要求全部受支持版本严格门禁，只有显式
 * `--target-app-version <x.y.z>` 才进入定向范围；package-mac 对定向记录必须收到匹配的 CLI 参数，
 * 不能把单版本 stamp 当全版本通过。
 *
 * 本模块无副作用，供 tools/verify.mjs、tools/package-mac.mjs 与测试共用。
 */

export const VALIDATION_SCOPE_ALL = 'all';
export const VALIDATION_SCOPE_TARGETED = 'targeted';
const SEMVER = /^\d+\.\d+\.\d+$/;

export function assertKnownVersions(supportedVersions) {
  const versions = [...(supportedVersions ?? [])];
  if (!versions.length) throw new Error('缺少受支持应用版本清单，无法确定发布验证范围');
  for (const version of versions) {
    if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`受支持版本清单含非法版本号：${JSON.stringify(version)}`);
  }
  if (new Set(versions).size !== versions.length) throw new Error('受支持版本清单含重复版本号');
  return versions;
}

export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return String(left).localeCompare(String(right));
}

/**
 * 解析 CLI 的 `--target-app-version <x.y.z>`（同时接受 `--target-app-version=<x.y.z>`）。
 * 无该参数返回 undefined；缺值/重复/格式错误直接抛错（失败关闭，不做隐式兜底）。
 */
export function parseTargetAppVersionArg(argv = []) {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value;
    if (argument === '--target-app-version') {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--target-app-version 需要一个明确的应用版本，例如 2.24.0');
      index += 1;
    } else if (argument.startsWith('--target-app-version=')) {
      value = argument.slice('--target-app-version='.length);
      if (!value) throw new Error('--target-app-version 需要一个明确的应用版本，例如 2.24.0');
    } else {
      continue;
    }
    if (!SEMVER.test(value)) throw new Error(`--target-app-version 版本格式无效：${JSON.stringify(value)}（应形如 2.24.0）`);
    if (target !== undefined) throw new Error('--target-app-version 只能指定一次，不得同时声明多个发布范围');
    target = value;
  }
  return target;
}

/**
 * verify 的范围解析：
 * - 无 `--target-app-version` → `all`（全部受支持版本都必须是发布通过条件，缺源即失败）；
 * - 有 → `targeted`（只有目标版本作为发布通过条件，其余列为本轮未验证，不是通过）。
 */
export function resolveValidationScope(argv = [], supportedVersions) {
  const supported = assertKnownVersions(supportedVersions).sort(compareVersions);
  const target = parseTargetAppVersionArg(argv);
  if (target === undefined) return { mode: VALIDATION_SCOPE_ALL, targetAppVersions: supported, historicalUnverified: [] };
  if (!supported.includes(target)) throw new Error(`未知目标应用版本 ${target}；受支持版本：${supported.join('、')}`);
  return { mode: VALIDATION_SCOPE_TARGETED, targetAppVersions: [target], historicalUnverified: supported.filter(version => version !== target) };
}

/** verified-release.json 中与范围相关的字段。 */
export function recordedScopeFields(scope) {
  return {
    validationScope: scope.mode,
    targetAppVersions: [...scope.targetAppVersions],
    historicalUnverified: [...scope.historicalUnverified],
  };
}

/**
 * 读取并规范化 `.cache/verified-release.json` 里的范围。
 * 旧记录若没有范围字段，视为“全部受支持版本”的旧式全量验证记录（旧 verify 只有全量门禁全过才写记录）；
 * 但定向记录缺失/损坏时绝不降级为全量。
 */
export function readRecordedScope(verification, supportedVersions) {
  if (!verification || typeof verification !== 'object') throw new Error('缺少可用的 .cache/verified-release.json 验证记录');
  const supported = assertKnownVersions(supportedVersions).sort(compareVersions);
  const declaredScope = verification.validationScope;
  const declaredTargets = verification.targetAppVersions;
  if (declaredScope === undefined && declaredTargets === undefined) {
    return { mode: VALIDATION_SCOPE_ALL, targetAppVersions: supported, historicalUnverified: [], legacy: true };
  }
  if (declaredScope !== VALIDATION_SCOPE_ALL && declaredScope !== VALIDATION_SCOPE_TARGETED) {
    throw new Error(`验证记录 validationScope 无效：${JSON.stringify(declaredScope)}（应为 all 或 targeted）`);
  }
  if (!Array.isArray(declaredTargets) || !declaredTargets.length) throw new Error('验证记录缺少 targetAppVersions，无法确认本次验证覆盖范围');
  for (const version of declaredTargets) {
    if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`验证记录 targetAppVersions 含非法版本号：${JSON.stringify(version)}`);
    if (!supported.includes(version)) throw new Error(`验证记录 targetAppVersions 含未知版本 ${version}`);
  }
  const targets = [...new Set(declaredTargets)].sort(compareVersions);
  if (declaredScope === VALIDATION_SCOPE_ALL && targets.length !== supported.length) {
    throw new Error('验证记录声明为全量范围，但 targetAppVersions 未覆盖全部受支持版本');
  }
  const historical = Array.isArray(verification.historicalUnverified)
    ? [...new Set(verification.historicalUnverified.filter(version => typeof version === 'string'))].sort(compareVersions)
    : supported.filter(version => !targets.includes(version));
  return { mode: declaredScope, targetAppVersions: targets, historicalUnverified: historical, legacy: false };
}

/**
 * package-mac 的打包范围解析：定向验证记录必须显式匹配 `--target-app-version`，否则拒绝打包。
 * 返回可供 build-info 与日志使用的范围对象（packagingTarget 为本次显式打包目标，可为 undefined）。
 */
export function resolvePackagingScope({ verification, argv = [], supportedVersions } = {}) {
  const supported = assertKnownVersions(supportedVersions).sort(compareVersions);
  const recorded = readRecordedScope(verification, supported);
  const cliTarget = parseTargetAppVersionArg(argv);
  if (cliTarget !== undefined && !supported.includes(cliTarget)) throw new Error(`未知目标应用版本 ${cliTarget}；受支持版本：${supported.join('、')}`);
  if (recorded.mode === VALIDATION_SCOPE_TARGETED) {
    if (cliTarget === undefined) {
      throw new Error(`已验证记录只覆盖定向版本 ${recorded.targetAppVersions.join('、')}；打包必须显式传 --target-app-version 且与记录一致，不能把单版本验证当作全版本通过`);
    }
    if (!recorded.targetAppVersions.includes(cliTarget)) {
      throw new Error(`--target-app-version ${cliTarget} 与已验证定向范围 ${recorded.targetAppVersions.join('、')} 不匹配，拒绝打包`);
    }
    return { mode: VALIDATION_SCOPE_TARGETED, targetAppVersions: [cliTarget], historicalUnverified: recorded.historicalUnverified.filter(version => version !== cliTarget), packagingTarget: cliTarget, legacy: recorded.legacy };
  }
  return { mode: VALIDATION_SCOPE_ALL, targetAppVersions: supported, historicalUnverified: [], packagingTarget: cliTarget, legacy: recorded.legacy };
}

/** build-info.json 的纯数据构造（validationScope 必须随包记录，不能把定向 stamp 当全版本）。 */
export function buildInfoPayload({ version, build, verification, scope, node } = {}) {
  if (!version) throw new Error('buildInfoPayload 需要 version');
  if (!verification?.digest) throw new Error('buildInfoPayload 需要已验证记录的 digest');
  if (!scope?.mode) throw new Error('buildInfoPayload 需要发布范围 scope');
  return {
    version,
    build,
    revision: verification.digest.slice(0, 8),
    sourceDigest: verification.digest,
    verifiedAt: verification.at,
    scriptManifest: verification.artifacts?.scripts ?? null,
    node,
    signing: 'local ad-hoc; not notarized',
    validationScope: {
      scope: scope.mode,
      targetAppVersions: [...scope.targetAppVersions],
      historicalUnverified: [...(scope.historicalUnverified ?? [])],
      ...(scope.packagingTarget ? { packagingTarget: scope.packagingTarget } : {}),
    },
  };
}

/** 人类可读的范围说明，供 verify/package 日志与报告复用。 */
export function describeValidationScope(scope) {
  if (scope.mode === VALIDATION_SCOPE_ALL) return `验证范围：全部受支持版本（${scope.targetAppVersions.join('、')}）`;
  return `验证范围：定向 ${scope.targetAppVersions.join('、')}；本轮未验证历史版本：${scope.historicalUnverified.length ? scope.historicalUnverified.join('、') : '无'}`;
}
