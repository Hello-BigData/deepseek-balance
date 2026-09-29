// 单调时钟：缓存 TTL 与看门狗**不能**用 `Date.now()` 差值。
//
// 为什么：系统时钟被回拨（NTP 校正、手动改时间、休眠唤醒）会让 `now - start` 变成负数，
// 于是 `now - start < TTL` 恒真 ⇒ 缓存**永久不失效**（余额 3s / usage 20s / 价格同步 12h），
// 看门狗也会因为 `now - last` 为负而失灵。这里统一改用单调源。
//
// 契约：monoNow() 只保证**单调不减**，其绝对值无意义（不要落盘、不要展示）；
//       isFresh 额外把「回拨造成的负差值」判为不新鲜，双保险。

/**
 * 单调毫秒。优先 performance.now()，其次 process.hrtime.bigint()，最后兜底 Date.now()。
 * @returns {number}
 */
export function monoNow() {
  try {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (e) { /* 继续降级 */ }
  try {
    if (typeof process !== 'undefined' && process && process.hrtime && typeof process.hrtime.bigint === 'function') {
      return Number(process.hrtime.bigint() / 1000000n);
    }
  } catch (e) { /* 继续降级 */ }
  return Date.now();
}

/**
 * 距 startMono 是否仍在 ttlMs 内。
 * 差值缺失或为负（时钟回拨）→ 判为「不新鲜」，避免缓存永久命中。
 * @param {number} startMono
 * @param {number} ttlMs
 * @param {number} nowMono
 * @returns {boolean}
 */
export function isFresh(startMono, ttlMs, nowMono) {
  const d = Number(nowMono) - Number(startMono);
  return Number.isFinite(d) && d >= 0 && d < Number(ttlMs);
}
