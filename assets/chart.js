/**
 * 图表：自绘 SVG，零依赖。
 * 几何计算是纯函数（可在 node 里测），DOM 部分在浏览器里跑。
 */

import { parseDateOnly, buildStepPath } from './logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 各标号的线条颜色（回退值；实际运行时优先读 CSS 变量 --grade-pXX）。 */
export const GRADE_COLORS = {
  p92: '#2563eb',
  p95: '#b45309',
  p98: '#7c3aed',
  p0: '#0e7490',
  p89: '#9d174d',
};

/** 各标号的线型（与图例一致：多序列不只靠颜色区分）。 */
export const GRADE_DASH = {
  p92: null,
  p95: '6 3',
  p98: '2 3',
  p0: '9 4',
  p89: '4 2 1 2',
};

function gradeColor(grade) {
  return cssVar(`--grade-${grade}`, GRADE_COLORS[grade] ?? '#2563eb');
}

const GRADE_LABELS = {
  p92: '92# 汽油',
  p95: '95# 汽油',
  p98: '98# 汽油',
  p0: '0# 柴油',
  p89: '89# 汽油',
};

const DEFAULT_PAD = { top: 30, right: 54, bottom: 26, left: 46 };

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
    for (const [, value] of entry.values ?? []) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      values.push(value);
    }
  }
  return values;
}

/**
 * 计算坐标映射。
 * 输入：{ series | points, overlay, width, height, pad }
 * series 每项：{ grade, values: [[date, value|null], ...] }
 * 输出：{ x, y, x2, y2, ticks, ticks2, width, height, plot }
 */
export function buildScales({ series = [], points = null, overlay = null, width, height, pad } = {}) {
  const normalizedSeries = series.length
    ? series
    : points
      ? [{ grade: 'p92', values: points }]
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

  const allPoints = normalizedSeries.flatMap((entry) => entry.values ?? []);
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
 * 生成图表绘制模型（纯函数，不碰 DOM，可在 node 里测）。
 * renderChart 只是把这份模型画到 SVG 上。
 */
export function buildChartModel({ series = [], points = null, overlay = null, width = 320, height = 260 } = {}) {
  const normalizedSeries = series.length
    ? series
    : points
      ? [{ grade: 'p92', values: points }]
      : [];

  const scales = buildScales({ series: normalizedSeries, overlay, width, height });
  const { plot, ticks, ticks2 } = scales;

  const paths = normalizedSeries.map((entry) => ({
    grade: entry.grade,
    d: buildStepPath(entry.values ?? [], scales.x, scales.y),
    markers: (entry.values ?? [])
      .filter(([, value]) => value !== null && value !== undefined && Number.isFinite(value))
      .map(([date, value]) => ({ date, value, x: scales.x(date), y: scales.y(value) })),
  }));

  const allPoints = normalizedSeries[0]?.values ?? [];
  const xLabels = pickLabelIndices(allPoints.length, 6).map((index) => {
    const [date] = allPoints[index];
    return { x: scales.x(date), text: date.slice(2).replace(/-/g, '/') };
  });

  const yLabels = ticks.map((tick) => ({ y: scales.y(tick), text: tick.toFixed(2) }));
  const rightLabels = ticks2 ? ticks2.map((tick) => ({ y: scales.y2(tick), text: tick.toFixed(1) })) : [];

  let overlayPath = null;
  if (overlay && overlay.length && scales.y2) {
    overlayPath = buildStepPath(overlay, scales.x, scales.y2);
  }

  return { scales, plot, paths, xLabels, yLabels, rightLabels, overlayPath };
}

/**
 * 渲染图表。
 * series: [{ grade, values }]，values: [[date, value|null], ...]
 * overlay: [[date, value], ...]（右轴）
 */
export function renderChart(svg, options = {}) {
  if (typeof document === 'undefined' || !svg || typeof svg.replaceChildren !== 'function') return;

  const { width = 320, height = 260 } = options;
  const model = buildChartModel(options);
  const { plot, scales } = model;

  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const fgMuted = cssVar('--fg-muted', '#5b636c');
  const grid = cssVar('--outline-soft', '#c4c7ce');

  // 颜色一律走 style（CSS 属性）：light-dark() 是 CSS 函数，写成 SVG 属性不解析
  const paint = (node, { stroke, fill } = {}) => {
    if (stroke) node.style.stroke = stroke;
    if (fill) node.style.fill = fill;
    return node;
  };

  // 网格线与左轴刻度
  for (const label of model.yLabels) {
    const line = el('line', { x1: plot.left, y1: label.y, x2: plot.right, y2: label.y, 'stroke-width': 1 });
    paint(line, { stroke: grid });
    svg.append(line);
    const text = el('text', {
      x: plot.left - 8, y: label.y + 4, 'text-anchor': 'end', 'font-size': 11,
    });
    paint(text, { fill: fgMuted });
    text.textContent = label.text;
    svg.append(text);
  }

  // 右轴刻度（叠加国际原油时）
  if (model.rightLabels.length) {
    for (const label of model.rightLabels) {
      const text = el('text', {
        x: plot.right + 8, y: label.y + 4, 'text-anchor': 'start', 'font-size': 11,
      });
      paint(text, { fill: fgMuted });
      text.textContent = label.text;
      svg.append(text);
    }
    const unit = el('text', {
      x: plot.right + 8, y: 12, 'text-anchor': 'start', 'font-size': 10,
    });
    paint(unit, { fill: fgMuted });
    unit.textContent = '美元/桶';
    svg.append(unit);
  }

  // 左轴单位
  const unitLeft = el('text', {
    x: plot.left - 8, y: 12, 'text-anchor': 'end', 'font-size': 10,
  });
  paint(unitLeft, { fill: fgMuted });
  unitLeft.textContent = '元/升';
  svg.append(unitLeft);

  // x 轴刻度
  for (const label of model.xLabels) {
    const text = el('text', {
      x: label.x, y: plot.bottom + 16, 'text-anchor': 'middle', 'font-size': 11,
    });
    paint(text, { fill: fgMuted });
    text.textContent = label.text;
    svg.append(text);
  }

  // 阶梯线 + 调价点（每档线型与图例一致）
  for (const path of model.paths) {
    const color = gradeColor(path.grade);
    if (path.d) {
      const step = el('path', {
        d: path.d, fill: 'none', 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        ...(GRADE_DASH[path.grade] ? { 'stroke-dasharray': GRADE_DASH[path.grade] } : {}),
      });
      paint(step, { stroke: color });
      svg.append(step);
    }
    for (const marker of path.markers) {
      const dot = el('circle', {
        cx: marker.x, cy: marker.y, r: 3.5, 'stroke-width': 1.5,
      });
      paint(dot, { fill: color, stroke: cssVar('--surface', '#ffffff') });
      svg.append(dot);
    }
  }

  // 叠加的国际原油（右轴，低饱和）
  if (model.overlayPath) {
    const overlay = el('path', {
      d: model.overlayPath, fill: 'none', 'stroke-width': 1.5, 'stroke-opacity': 0.55,
    });
    paint(overlay, { stroke: fgMuted });
    svg.append(overlay);
  }

  // 供读屏与 tooltip 使用的元信息
  svg.dataset.pointCount = String(model.paths[0]?.markers.length ?? 0);
  svg.dataset.seriesCount = String(model.paths.length);
  svg.__chartModel = model;
  return model;
}

export { GRADE_LABELS };
