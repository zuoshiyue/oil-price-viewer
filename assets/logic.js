/**
 * 前端纯逻辑：区间切片、平滑曲线路径、格式化、空态判定。
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

/**
 * 取区间的下标范围。
 * - rangeStartIdx：区间内第一个窗口的下标（区间内没有窗口时为 dates.length）
 * - startIdx：图表起点，比 rangeStartIdx 早一个窗口 —— 曲线需要区间前的那个点作为起始段，趋势才完整
 */
export function selectRange(dates, rangeKey, now) {
  const days = RANGES[rangeKey] ?? RANGES.month;
  const cutoff = now.getTime() - days * 86400000;
  let rangeStartIdx = dates.length;
  for (let i = 0; i < dates.length; i += 1) {
    if (parseDateOnly(dates[i]).getTime() >= cutoff) {
      rangeStartIdx = i;
      break;
    }
  }
  const startIdx = rangeStartIdx === 0 ? 0 : Math.max(0, rangeStartIdx - 1);
  return { startIdx, endIdx: dates.length - 1, rangeStartIdx };
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
 * 平滑曲线路径（Fritsch–Carlson 单调三次插值 → 三次贝塞尔）：
 * - 调价点稀疏时比阶梯线好看，且单调约束保证陡变处不过冲、不产生数据里不存在的假峰
 * - 平价数据退化为直线；空值处断开成新的一段
 * 注意：曲线只是趋势的视觉连接，真实数据点由图表上的圆点标记。
 */
export function buildSmoothPath(points, x, y) {
  const segments = [];
  let current = null;
  for (const [date, value] of points) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      current = null;
      continue;
    }
    const point = [x(date), y(value)];
    if (current === null) {
      current = [point];
      segments.push(current);
    } else {
      current.push(point);
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  const parts = [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    parts.push(`M${round(segment[0][0])} ${round(segment[0][1])}`);
    if (segment.length === 1) continue;

    const n = segment.length;
    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = segment[i + 1][0] - segment[i][0];
      slope[i] = (segment[i + 1][1] - segment[i][1]) / dx[i];
    }
    const tangent = new Array(n);
    tangent[0] = slope[0];
    tangent[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      if (slope[i - 1] * slope[i] <= 0) {
        tangent[i] = 0;
      } else {
        tangent[i] = (slope[i - 1] + slope[i]) / 2;
      }
    }
    // Fritsch–Carlson 防过冲：切向量限制在 3 倍局部斜率内
    for (let i = 0; i < n - 1; i += 1) {
      const limit = 3 * Math.abs(slope[i]);
      if (Math.abs(tangent[i]) > limit) tangent[i] = Math.sign(tangent[i]) * limit;
      if (Math.abs(tangent[i + 1]) > limit) tangent[i + 1] = Math.sign(tangent[i + 1]) * limit;
    }

    for (let i = 0; i < n - 1; i += 1) {
      const h = dx[i];
      const c1x = segment[i][0] + h / 3;
      const c1y = segment[i][1] + (tangent[i] * h) / 3;
      const c2x = segment[i + 1][0] - h / 3;
      const c2y = segment[i + 1][1] - (tangent[i + 1] * h) / 3;
      parts.push(
        `C${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(segment[i + 1][0])} ${round(segment[i + 1][1])}`,
      );
    }
  }
  return parts.join(' ');
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

/** 图表十字线用：找横坐标离 x 最近的数据点。 */
export function nearestByX(items, x) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const item of items) {
    if (item === null || item === undefined || !Number.isFinite(item.x)) continue;
    const distance = Math.abs(item.x - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}
