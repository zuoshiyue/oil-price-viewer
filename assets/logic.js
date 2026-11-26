/**
 * 前端纯逻辑：区间切片、阶梯路径、格式化、空态判定。
 * 纯 ESM、无 DOM 依赖 —— node 与浏览器共用同一份实现。
 */

/** 时间区间（天）。 */
export const RANGES = { week: 7, month: 30, year: 365 };

/** 快照过期阈值（小时）。 */
export const STALE_HOURS = 6;

/**
 * 按北京时间零点解析 YYYY-MM-DD。
 * 直接 new Date('2026-11-13') 会按 UTC 解析，日期会整体前移一天。
 */
export function parseDateOnly(value) {
  return new Date(`${value}T00:00:00+08:00`);
}

/** 取区间内的下标范围。 */
export function selectRange(dates, rangeKey, now) {
  const days = RANGES[rangeKey] ?? RANGES.month;
  const cutoff = now.getTime() - days * 86400000;
  let startIdx = 0;
  for (let i = 0; i < dates.length; i += 1) {
    if (parseDateOnly(dates[i]).getTime() >= cutoff) {
      startIdx = i;
      break;
    }
    startIdx = i + 1;
  }
  if (startIdx >= dates.length) startIdx = Math.max(0, dates.length - 1);
  return { startIdx, endIdx: dates.length - 1 };
}

/** 截取区间内的价格序列，保持与日期对齐。 */
export function sliceSeries(dates, prices, startIdx, endIdx) {
  const out = [];
  for (let i = Math.max(0, startIdx); i <= Math.min(endIdx, dates.length - 1); i += 1) {
    out.push([dates[i], prices?.[i] ?? null]);
  }
  return out;
}

/**
 * 阶梯线路径：价格只在调价日跳变，调价之间保持不变。
 * 空值处断开成新的一段（不跨空值连线）。
 */
export function buildStepPath(points, x, y) {
  const segments = [];
  let current = null;
  for (const [date, value] of points) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      current = null;
      continue;
    }
    const px = x(date);
    const py = y(value);
    if (current === null) {
      segments.push(`M${px} ${py}`);
    } else {
      segments.push(`L${px} ${current.y}`);
      segments.push(`L${px} ${py}`);
    }
    current = { x: px, y: py };
  }
  return segments.join(' ');
}

/** 当前价：最后一个有效值。 */
export function currentPrice(prices) {
  if (!Array.isArray(prices)) return null;
  for (let i = prices.length - 1; i >= 0; i -= 1) {
    const value = prices[i];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

/** 最近一次价格变化的窗口（跳过"不调价"窗口）。 */
export function latestAdjustment(prices, dates) {
  if (!Array.isArray(prices)) return null;
  for (let i = prices.length - 1; i >= 1; i -= 1) {
    const cur = prices[i];
    const prev = prices[i - 1];
    if (cur === null || cur === undefined || prev === null || prev === undefined) continue;
    if (cur === prev) continue;
    return { date: dates[i], delta: Math.round((cur - prev) * 100) / 100 };
  }
  return null;
}

/** 价格格式化：两位小数，空值显示破折号。 */
export function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

/** 涨跌格式化：带 ↑/↓，不单靠颜色表达。 */
export function formatDelta(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value > 0) return `↑${value.toFixed(2)}`;
  if (value < 0) return `↓${Math.abs(value).toFixed(2)}`;
  return '持平';
}

/** 涨跌对应的语义类名。 */
export function deltaClass(value) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/** 快照是否过期。 */
export function isStale(generatedAt, now, hours = STALE_HOURS) {
  if (!generatedAt) return true;
  const stamp = Date.parse(generatedAt);
  if (Number.isNaN(stamp)) return true;
  return now.getTime() - stamp > hours * 3600000;
}

/** 区间内是否发生过调价（用于"本区间无调价"提示）。 */
export function hasAdjustmentInRange(dates, prices, startIdx, endIdx) {
  if (!Array.isArray(prices)) return false;
  for (let i = Math.max(1, startIdx); i <= Math.min(endIdx, prices.length - 1); i += 1) {
    const cur = prices[i];
    const prev = prices[i - 1];
    if (cur === null || cur === undefined || prev === null || prev === undefined) continue;
    if (cur !== prev) return true;
  }
  return false;
}
