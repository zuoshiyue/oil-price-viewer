import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceTicks, buildScales, renderChart } from './chart.js';

const POINTS = [
  ['2026-01-05', 8.2],
  ['2026-01-15', 8.5],
  ['2026-01-25', 8.4],
];

test('niceTicks 首尾包含最小值与最大值', () => {
  const ticks = niceTicks(8.0, 8.6, 4);
  assert.equal(ticks[0], 8);
  assert.equal(ticks[ticks.length - 1], 8.6);
});

test('niceTicks 步长是可读的刻度值', () => {
  const ticks = niceTicks(8.0, 8.6, 4);
  const step = ticks[1] - ticks[0];
  const readable = [0.1, 0.2, 0.25, 0.5, 1];
  assert.ok(
    readable.some((value) => Math.abs(step - value) < 1e-9),
    `步长 ${step} 不在可读刻度里`,
  );
});

test('niceTicks 刻度数量克制', () => {
  const ticks = niceTicks(8.0, 8.6, 4);
  assert.ok(ticks.length <= 6, `刻度过多：${ticks.length}`);
});

test('niceTicks 最大值等于最小值时不会除零', () => {
  assert.deepEqual(niceTicks(5, 5), [5]);
});

test('niceTicks 输入非法时返回空数组', () => {
  assert.deepEqual(niceTicks(NaN, 1), []);
});

test('buildScales 的 x 随时间单调递增', () => {
  const scales = buildScales({ points: POINTS, width: 400, height: 240 });
  const xs = POINTS.map(([date]) => scales.x(date));
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], `x 不单调：${xs.join(',')}`);
});

test('buildScales 的 y 随价格增大而变小', () => {
  const scales = buildScales({ points: POINTS, width: 400, height: 240 });
  assert.ok(scales.y(8.5) < scales.y(8.2), '高价应更靠上');
});

test('buildScales 的 y 落在画布高度内', () => {
  const scales = buildScales({ points: POINTS, width: 400, height: 240 });
  const y = scales.y(8.37);
  assert.ok(y >= 0 && y <= 240, `y=${y} 超出画布`);
});

test('buildScales 提供 y 轴刻度', () => {
  const scales = buildScales({ points: POINTS, width: 400, height: 240 });
  assert.ok(scales.ticks.length >= 2);
  assert.equal(scales.ticks[0], Math.min(...scales.ticks));
});

test('buildScales 有叠加序列时提供右轴刻度', () => {
  const scales = buildScales({
    points: POINTS,
    overlay: [['2026-01-05', 90.1], ['2026-01-25', 89.5]],
    width: 400,
    height: 240,
  });
  assert.ok(scales.ticks2.length >= 2);
  assert.equal(typeof scales.y2, 'function');
});

test('buildScales 多条序列时 y 值域覆盖所有序列', () => {
  const scales = buildScales({
    series: [
      { grade: 'p92', points: POINTS },
      { grade: 'p95', points: [['2026-01-05', 9.1], ['2026-01-25', 9.3]] },
    ],
    width: 400,
    height: 240,
  });
  assert.ok(scales.ticks[scales.ticks.length - 1] >= 9.3, '右边界应覆盖 95 号最高价');
});

test('buildScales 只有一个数据点时不除零', () => {
  const scales = buildScales({ points: [['2026-01-05', 8.2]], width: 400, height: 240 });
  assert.ok(Number.isFinite(scales.x('2026-01-05')));
  assert.ok(Number.isFinite(scales.y(8.2)));
});

test('renderChart 在没有 DOM 时不抛错', () => {
  assert.doesNotThrow(() => renderChart(null, { points: POINTS, width: 400, height: 240 }));
  assert.doesNotThrow(() => renderChart(undefined, {}));
});

test('renderChart 空数据时不抛错', () => {
  assert.doesNotThrow(() => renderChart(null, { points: [], width: 400, height: 240 }));
});
