/**
 * 图表：自绘 SVG，零依赖。
 * 几何计算是纯函数（可在 node 里测），DOM 部分在浏览器里跑。
 */

import { parseDateOnly, buildStepPath } from './logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 各标号的线条颜色（与 styles.css 里的图例一致）。 */
export const GRADE_COLORS = {
  p92: '#2563eb',
  p95: '#b45309',
  p98: '#7c3aed',
  p0: '#0e7490',
  p89: '#9d174d',
};

const GRADE_LABELS = {
  p92: '92# 汽油',
  p95: '95# 汽油',
  p98: '98# 汽油',
  p0: '0# 柴油',
  p89: '89# 汽油',
};

const DEFAULT_PAD = { top: 16, right: 54, bottom: 26, left: 46 };

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** 生成可读的刻度值（含首尾）。 */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  let stepFactor;
  if (normalized <= 1) stepFactor = 1;
  else if (normalized <= 2) stepFactor = 2;
  else if (normalized <= 2.5) stepFactor = 2.5;
  else if (normalized <= 5) stepFactor = 5;
  else stepFactor = 10;
  const step = stepFactor * magnitude;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  const start = Math.floor(min / step + 1e-9) * step;
  const end = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 1000; v += step) {
    ticks.push(roundTo(v, decimals));
  }
  return ticks;
}

function collectValues(series) {
  const values = [];
  for (const entry of series) {
    for (const [, value] of entry.points) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      values.push(value);
    }
  }
  return values;
}

/**
 * 计算坐标映射。
 * 输入：{ series | points, overlay, width, height, pad }
 * 输出：{ x, y, x2, y2, ticks, ticks2, width, height, plot }
 */
export function buildScales({ series = [], points = null, overlay = null, width, height, pad } = {}) {
  const normalizedSeries = series.length
    ? series
    : points
      ? [{ grade: 'p92', points }]
      : [];

  const p = { ...DEFAULT_PAD, ...(pad ?? {}) };
  const plot = {
    left: p.left,
    right: Math.max(p.left + 1, width - p.right),
    top: p.top,
    bottom: Math.max(p.top + 1, height - p.bottom),
  };
  plot.width = Math.max(1, plot.right - plot.left);
  plot.height = Math.max(1, plot.bottom - plot.top);

  const allPoints = normalizedSeries.flatMap((entry) => entry.points);
  const times = allPoints.map(([date]) => parseDateOnly(date).getTime());
  const tMin = times.length ? Math.min(...times) : 0;
  const tMax = times.length ? Math.max(...times) : 1;

  const x = (date) => {
    const t = parseDateOnly(date).getTime();
    if (tMax === tMin) return plot.left + plot.width / 2;
    return plot.left + ((t - tMin) / (tMax - tMin)) * plot.width;
  };

  const values = collectValues(normalizedSeries);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const ticks = niceTicks(min, max, 5);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1] ?? 1;
  const y = (value) => {
    if (yMax === yMin) return plot.top + plot.height / 2;
    return plot.top + ((yMax - value) / (yMax - yMin)) * plot.height;
  };

  const result = { x, y, ticks, width, height, plot, series: normalizedSeries };

  if (overlay && overlay.length) {
    const overlayValues = overlay.map(([, value]) => value).filter((v) => Number.isFinite(v));
    const oMin = overlayValues.length ? Math.min(...overlayValues) : 0;
    const oMax = overlayValues.length ? Math.max(...overlayValues) : 1;
    const ticks2 = niceTicks(oMin, oMax, 4);
    const oyMin = ticks2[0];
    const oyMax = ticks2[ticks2.length - 1] ?? 1;
    result.ticks2 = ticks2;
    result.x2 = x;
    result.y2 = (value) => {
      if (oyMax === oyMin) return plot.top + plot.height / 2;
      return plot.top + ((oyMax - value) / (oyMax - oyMin)) * plot.height;
    };
  }

  return result;
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** x 轴标签抽稀：最多 maxLabels 个。 */
function pickLabelIndices(count, maxLabels) {
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / maxLabels);
  const indices = [];
  for (let i = 0; i < count; i += step) indices.push(i);
  if (indices[indices.length - 1] !== count - 1) indices.push(count - 1);
  return indices;
}

/**
 * 渲染图表。
 * series: [{ grade, points }]，points: [[date, value|null], ...]
 * overlay: [[date, value], ...]（右轴）
 */
export function renderChart(svg, { series = [], points = null, overlay = null, width = 320, height = 260 } = {}) {
  if (typeof document === 'undefined' || !svg || typeof svg.replaceChildren !== 'function') return;

  const normalizedSeries = series.length
    ? series
    : points
      ? [{ grade: 'p92', points }]
      : [];

  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const scales = buildScales({ series: normalizedSeries, overlay, width, height });
  const { plot, ticks, ticks2 } = scales;

  const fgMuted = cssVar('--fg-muted', '#5b636c');
  const border = cssVar('--border', '#e2e5ea');
  const axisText = cssVar('--fg', '#1c2024');

  // 网格线与左轴刻度
  for (const tick of ticks) {
    const y = scales.y(tick);
    svg.append(el('line', {
      x1: plot.left, y1: y, x2: plot.right, y2: y, stroke: border, 'stroke-width': 1,
    }));
    const label = el('text', {
      x: plot.left - 8, y: y + 4, 'text-anchor': 'end', fill: fgMuted, 'font-size': 11,
    });
    label.textContent = tick.toFixed(2);
    svg.append(label);
  }

  // 右轴刻度（叠加国际原油时）
  if (ticks2) {
    for (const tick of ticks2) {
      const y = scales.y2(tick);
      const label = el('text', {
        x: plot.right + 8, y: y + 4, 'text-anchor': 'start', fill: fgMuted, 'font-size': 11,
      });
      label.textContent = tick.toFixed(1);
      svg.append(label);
    }
    const unit = el('text', {
      x: plot.right + 8, y: plot.top - 4, 'text-anchor': 'start', fill: fgMuted, 'font-size': 10,
    });
    unit.textContent = '美元/桶';
    svg.append(unit);
  }

  // 左轴单位
  const unitLeft = el('text', {
    x: plot.left - 8, y: plot.top - 4, 'text-anchor': 'end', fill: fgMuted, 'font-size': 10,
  });
  unitLeft.textContent = '元/升';
  svg.append(unitLeft);

  // x 轴刻度
  const allPoints = normalizedSeries[0]?.points ?? [];
  const labelIndices = pickLabelIndices(allPoints.length, 6);
  for (const index of labelIndices) {
    const [date] = allPoints[index];
    const x = scales.x(date);
    const label = el('text', {
      x, y: plot.bottom + 16, 'text-anchor': 'middle', fill: fgMuted, 'font-size': 11,
    });
    label.textContent = date.slice(2).replace(/-/g, '/');
    svg.append(label);
  }

  // 阶梯线 + 调价点
  for (const entry of normalizedSeries) {
    const color = GRADE_COLORS[entry.grade] ?? cssVar('--accent', '#2563eb');
    const pathData = buildStepPath(entry.points, scales.x, scales.y);
    if (pathData) {
      svg.append(el('path', {
        d: pathData, fill: 'none', stroke: color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }
    for (const [date, value] of entry.points) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      svg.append(el('circle', {
        cx: scales.x(date), cy: scales.y(value), r: 3, fill: color,
        stroke: cssVar('--surface', '#ffffff'), 'stroke-width': 1,
      }));
    }
  }

  // 叠加的国际原油（右轴，低饱和）
  if (overlay && overlay.length && scales.y2) {
    const pathData = buildStepPath(overlay, scales.x, scales.y2);
    if (pathData) {
      svg.append(el('path', {
        d: pathData, fill: 'none', stroke: fgMuted, 'stroke-width': 1.5, 'stroke-opacity': 0.55,
      }));
    }
  }

  // 供读屏与 tooltip 使用的元信息
  svg.dataset.pointCount = String(allPoints.length);
  svg.dataset.seriesCount = String(normalizedSeries.length);
}

export { GRADE_LABELS };
