// 用量归档（纯函数，供路由复用）。
//
// 背景：宿主 `usage-ledger.json` 有硬上限 5000 条，超出即丢最旧的 ⇒ 插件「全部」区间被 5000 卡住。
// 插件改不了宿主，但可以**自己归档**：每次读到宿主账本时按 `requestId` 去重并进归档文件，
// 聚合时读「宿主账本 ∪ 归档」，使区间能跨过 5000 上限。
//
// 容量：归档自身上限 `MAX_ARCHIVE`（20000），到顶丢最旧；到顶对用户可见（接口 / 页脚标注）。
//
// 安全：归档只保留聚合所需字段（`requestId`/`startedAt`/`model`/`usage`），**丢弃**宿主条目里
// 的 attribution / metadata / sessionPath 等（其中可能含路径等敏感信息），绝不落盘。
// 注意：条目本身不含 `user_id`（宿主账本不记），本模块也不引入任何标识。

/** 归档文件名（写在插件数据目录下） */
export const ARCHIVE_FILE = 'usage-archive.json';
/** 归档条数上限：到顶丢最旧 */
export const MAX_ARCHIVE = 20000;

/**
 * 条目去重键：优先 `requestId`；缺失时用 `startedAt|modelId|totalTokens` 兜底。
 * @param {*} e
 * @returns {string}
 */
export function entryKey(e) {
  if (e && typeof e.requestId === 'string' && e.requestId) return 'r:' + e.requestId;
  const m = e && e.model ? e.model.modelId : '';
  const u = e && e.usage ? e.usage.totalTokens : '';
  return 'c:' + String(e && e.startedAt) + '|' + String(m) + '|' + String(u);
}

/**
 * 裁剪为聚合所需字段（宿主条目含 ~1.8KB 的 attribution/metadata，必须裁掉再落盘）。
 * @param {*} e
 * @returns {object}
 */
export function trimEntry(e) {
  const u = (e && e.usage) || {};
  const cache = u.cache || {};
  const input = u.input || {};
  const output = u.output || {};
  return {
    requestId: (e && e.requestId) || null,
    startedAt: (e && e.startedAt) || null,
    model: { provider: e && e.model ? e.model.provider : null, modelId: e && e.model ? e.model.modelId : null },
    usage: {
      totalTokens: u.totalTokens,
      input: { uncachedTokens: input.uncachedTokens, totalTokens: input.totalTokens },
      output: { totalTokens: output.totalTokens },
      cache: { readTokens: cache.readTokens, writeTokens: cache.writeTokens, missTokens: cache.missTokens },
    },
  };
}

/**
 * 把宿主账本并进归档（按 entryKey 去重；新条目裁剪后入档）。
 * @param {Array} existing 归档现有条目
 * @param {Array} incoming 宿主账本条目
 * @param {number} [cap] 上限，默认 MAX_ARCHIVE
 * @returns {{entries:Array, added:number, dropped:number}}
 */
export function mergeEntries(existing, incoming, cap) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MAX_ARCHIVE;
  const byKey = new Map();
  for (const e of (Array.isArray(existing) ? existing : [])) { if (e) byKey.set(entryKey(e), e); }
  let added = 0;
  for (const e of (Array.isArray(incoming) ? incoming : [])) {
    if (!e) continue;
    const k = entryKey(e);
    if (!byKey.has(k)) { byKey.set(k, trimEntry(e)); added += 1; }
  }
  let entries = Array.from(byKey.values());
  entries.sort((a, b) => String((a && a.startedAt) || '').localeCompare(String((b && b.startedAt) || '')));
  let dropped = 0;
  if (entries.length > limit) { dropped = entries.length - limit; entries = entries.slice(dropped); }
  return { entries, added, dropped };
}

/**
 * 聚合用并集：归档 ∪ 宿主账本（按 entryKey 去重，先到先得）。
 * @param {Array} archiveEntries
 * @param {Array} ledgerEntries
 * @returns {Array}
 */
export function unionEntries(archiveEntries, ledgerEntries) {
  const byKey = new Map();
  for (const e of (Array.isArray(archiveEntries) ? archiveEntries : [])) { if (e) byKey.set(entryKey(e), e); }
  for (const e of (Array.isArray(ledgerEntries) ? ledgerEntries : [])) {
    if (!e) continue;
    const k = entryKey(e);
    if (!byKey.has(k)) byKey.set(k, e);
  }
  return Array.from(byKey.values());
}

/**
 * 归档状态（给接口/页脚用）。
 * @param {number} entryCount
 * @param {number} [cap]
 * @param {string|null} [oldestAt]
 * @returns {{count:number, cap:number, full:boolean, oldestAt:string|null}}
 */
export function archiveStatus(entryCount, cap, oldestAt) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MAX_ARCHIVE;
  const n = Number.isFinite(entryCount) && entryCount > 0 ? Math.floor(entryCount) : 0;
  return { count: n, cap: limit, full: n >= limit, oldestAt: oldestAt || null };
}
