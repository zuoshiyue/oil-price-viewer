import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANGES,
  selectRange,
  sliceSeries,
  buildSmoothPath,
  currentPrice,
  latestAdjustment,
  formatPrice,
  formatDelta,
  deltaClass,
  isStale,
  hasAdjustmentInRange,
  nearestByX,
  parseDateOnly,
} from './logic.js';

const DATES = ['2026-11-01', '2026-11-07', '2026-11-13', '2026-11-20'];
const NOW = new Date('2026-11-26T04:00:00Z'); // 北京时间 2026-11-26 12:00

test('RANGES 覆盖一周/一月/一年', () => {
  assert.deepEqual(RANGES, { week: 7, month: 30, year: 365 });
});

test('parseDateOnly 按北京时间零点解析，不被 UTC 截断', () => {
  const parsed = parseDateOnly('2026-11-13');
  assert.equal(parsed.toISOString(), '2026-11-12T16:00:00.000Z');
});

test('selectRange: 近一周只取 7 天内的窗口', () => {
  const { startIdx, endIdx } = selectRange(DATES, 'week', NOW);
  assert.ok(startIdx >= 2, `startIdx 应落在 11-13 之后，实际 ${startIdx}`);
  assert.equal(endIdx, DATES.length - 1);
});

test('selectRange: 近一月取 30 天内', () => {
  const { startIdx } = selectRange(DATES, 'month', NOW);
  assert.equal(startIdx, 0);
});

test('selectRange: 近一年在数据不足一年时取全部', () => {
  const { startIdx } = selectRange(DATES, 'year', NOW);
  assert.equal(startIdx, 0);
});

test('selectRange: 区间早于全部数据时 startIdx 为 0', () => {
  const { startIdx, endIdx } = selectRange(DATES, 'week', new Date('2020-01-01T00:00:00Z'));
  assert.equal(startIdx, 0);
  assert.equal(endIdx, DATES.length - 1);
});

test('selectRange: 图表起点包含区间前的那个窗口（曲线的起始段）', () => {
  const { startIdx, rangeStartIdx } = selectRange(DATES, 'week', NOW);
  assert.equal(rangeStartIdx, 3, '区间内第一个窗口是 11-20');
  assert.equal(startIdx, 2, '图表从区间前一个窗口（11-13）起画');
});

test('selectRange: 区间内没有窗口时 rangeStartIdx 指向末尾之后', () => {
  const { rangeStartIdx, startIdx } = selectRange(DATES, 'week', new Date('2026-12-10T12:00:00+08:00'));
  assert.equal(rangeStartIdx, DATES.length);
  assert.equal(startIdx, DATES.length - 1, '仍保留最后一个窗口作为当前价锚点');
});

test('sliceSeries 截取区间内的序列并保持对齐', () => {
  const prices = [1, 2, 3, 4];
  const sliced = sliceSeries(DATES, prices, 1, 2);
  assert.deepEqual(sliced, [['2026-11-07', 2], ['2026-11-13', 3]]);
});

test('buildSmoothPath 两点间用一条三次贝塞尔连接', () => {
  const points = [['2026-01-01', 8.0], ['2026-01-11', 8.5]];
  const x = (d) => Number(d.slice(-2));
  const y = (v) => v;
  const path = buildSmoothPath(points, x, y);
  assert.ok(path.startsWith('M'));
  assert.equal((path.match(/C/g) ?? []).length, 1, '应为 1 个 C 命令');
  assert.ok(path.endsWith('11 8.5'), `终点应是第二个点，实际 ${path}`);
});

test('buildSmoothPath n 个点产出 n-1 条曲线段', () => {
  const points = [['2026-01-01', 8.0], ['2026-01-11', 8.5], ['2026-01-21', 8.2], ['2026-01-31', 8.6]];
  const path = buildSmoothPath(points, (d) => Number(d.slice(-2)), (v) => v);
  assert.equal((path.match(/C/g) ?? []).length, 3);
  assert.equal((path.match(/M/g) ?? []).length, 1);
});

test('buildSmoothPath 平价数据退化为直线（控制点不偏离）', () => {
  const points = [['2026-01-01', 8.0], ['2026-01-11', 8.0], ['2026-01-21', 8.0]];
  const path = buildSmoothPath(points, (d) => Number(d.slice(-2)), (v) => v);
  const numbers = (path.match(/-?[\d.]+/g) ?? []).map(Number);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  assert.ok(ys.every((value) => value === 8), `平价曲线的 y 全应为 8：${ys.join(',')}`);
});

test('buildSmoothPath 单调数据不过冲（所有 y 落在数据值域内）', () => {
  const points = [['2026-01-01', 8.0], ['2026-01-11', 8.6], ['2026-01-21', 8.2], ['2026-01-31', 8.7]];
  const path = buildSmoothPath(points, (d) => Number(d.slice(-2)), (v) => v);
  const numbers = (path.match(/-?[\d.]+/g) ?? []).map(Number);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  assert.ok(
    ys.every((value) => value >= 8.0 - 0.01 && value <= 8.7 + 0.01),
    `曲线 y 超出数据值域 [8.0, 8.7]：${ys.join(',')}`,
  );
});

test('buildSmoothPath 跳过空值且不产生 NaN', () => {
  const points = [['2026-01-01', 8.0], ['2026-01-11', null], ['2026-01-21', 8.5]];
  const path = buildSmoothPath(points, (d) => Number(d.slice(-2)), (v) => v);
  assert.ok(!path.includes('NaN'));
  assert.equal((path.match(/M/g) ?? []).length, 2, '空值处断开成新的一段');
});

test('buildSmoothPath 全部为空值时返回空串', () => {
  const path = buildSmoothPath([['2026-01-01', null]], (d) => 1, (v) => v);
  assert.equal(path, '');
});

test('buildSmoothPath 单点只有 M 命令', () => {
  const path = buildSmoothPath([['2026-01-01', 8.0]], (d) => 5, (v) => v);
  assert.equal(path, 'M5 8');
});

test('currentPrice 取最后一个有效值', () => {
  assert.equal(currentPrice([8.37, 8.61]), 8.61);
});

test('currentPrice 末尾为空时往前找', () => {
  assert.equal(currentPrice([8.37, null]), 8.37);
});

test('currentPrice 全空返回 null', () => {
  assert.equal(currentPrice([null, null]), null);
});

test('latestAdjustment 找到最近一次价格变化的窗口', () => {
  const adj = latestAdjustment([8.29, 8.61, 8.61], ['2026-10-16', '2026-10-30', '2026-11-13']);
  assert.deepEqual(adj, { date: '2026-10-30', delta: 0.32 });
});

test('latestAdjustment 末窗才是变化点时取末窗', () => {
  const adj = latestAdjustment([8.61, 8.61, 8.89], ['2026-10-16', '2026-10-30', '2026-11-13']);
  assert.deepEqual(adj, { date: '2026-11-13', delta: 0.28 });
});

test('latestAdjustment 全部未变时返回 null', () => {
  const adj = latestAdjustment([8.61, 8.61, 8.61], ['2026-10-16', '2026-10-30', '2026-11-13']);
  assert.equal(adj, null);
});

test('latestAdjustment 负数为下调', () => {
  const adj = latestAdjustment([8.89, 8.37], ['2026-10-30', '2026-11-13']);
  assert.deepEqual(adj, { date: '2026-11-13', delta: -0.52 });
});

test('formatPrice 空值显示破折号', () => {
  assert.equal(formatPrice(null), '—');
});

test('formatPrice 保留两位小数', () => {
  assert.equal(formatPrice(8.37), '8.37');
  assert.equal(formatPrice(8), '8.00');
});

test('formatDelta 上调带箭头', () => {
  assert.match(formatDelta(0.52), /↑/);
  assert.match(formatDelta(0.52), /0\.52/);
});

test('formatDelta 下调带箭头', () => {
  assert.match(formatDelta(-0.52), /↓/);
});

test('formatDelta 无变化显示持平', () => {
  assert.equal(formatDelta(0), '持平');
});

test('formatDelta 空值显示破折号', () => {
  assert.equal(formatDelta(null), '—');
});

test('deltaClass 区分涨/跌/平', () => {
  assert.equal(deltaClass(0.52), 'up');
  assert.equal(deltaClass(-0.52), 'down');
  assert.equal(deltaClass(0), 'flat');
  assert.equal(deltaClass(null), 'flat');
});

test('isStale 六小时内不算过期', () => {
  assert.equal(isStale('2026-11-26T08:20:11+08:00', new Date('2026-11-26T14:00:00+08:00')), false);
});

test('isStale 超过六小时算过期', () => {
  assert.equal(isStale('2026-11-26T02:00:00+08:00', new Date('2026-11-26T15:00:00+08:00')), true);
});

test('hasAdjustmentInRange 区间内有调价点时为真', () => {
  assert.equal(hasAdjustmentInRange(DATES, [8.61, 8.61, 8.89, 8.89], 0, 3), true);
});

test('hasAdjustmentInRange 区间内全是平价时为假', () => {
  assert.equal(hasAdjustmentInRange(DATES, [8.61, 8.61, 8.61, 8.61], 0, 3), false);
});

test('hasAdjustmentInRange 忽略空值相邻比较', () => {
  assert.equal(hasAdjustmentInRange(DATES, [8.61, null, null, 8.61], 0, 3), false);
});

test('nearestByX 返回距离最近的数据点', () => {
  const items = [{ x: 10, value: 8.61 }, { x: 50, value: 8.89 }, { x: 90, value: 8.37 }];
  assert.equal(nearestByX(items, 12).value, 8.61);
  assert.equal(nearestByX(items, 60).value, 8.89);
  assert.equal(nearestByX(items, 1000).value, 8.37);
});

test('nearestByX 空数组返回 null', () => {
  assert.equal(nearestByX([], 10), null);
});
