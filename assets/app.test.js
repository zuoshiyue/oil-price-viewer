import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveView, applyLiveUpdate, matchRegionName } from './app.js';
import { buildScales } from './chart.js';

const DATES = ['2026-10-16', '2026-10-30', '2026-11-13'];

const SNAPSHOT = {
  meta: {
    generatedAt: '2026-11-26T08:20:11+08:00',
    schemaVersion: 2,
    lastWindow: { date: '2026-11-13' },
    nextWindow: { date: '2026-11-27', gasolineChange: -440, dieselChange: -425 },
    crude: { wti: 83.27, brent: 89.81, wtiChange: -0.49, brentChange: -0.92, time: '2026-11-26 17:22:07' },
    sources: [{ name: '金投网', url: 'https://quote.cngold.org/oil/youjia.html' }],
    notes: { priceBasis: '发改委挂牌价（生效日口径），非加油站成交价' },
  },
  dates: DATES,
  national: {
    p92: [8.66, 8.94, 8.42],
    p95: [9.22, 9.51, 8.99],
    p98: [10.45, 10.74, 10.23],
    p0: [8.29, 8.57, 8.05],
    p89: [null, null, 6.9],
    lastAdjust: { date: '2026-11-13', p92: -0.52, p95: -0.52, p98: -0.51, p0: -0.52 },
  },
  regions: {
    北京市: {
      regionId: 2,
      p92: [8.61, 8.89, 8.37],
      p95: [9.17, 9.46, 8.91],
      p98: [10.67, 10.96, 10.41],
      p0: [8.36, 8.65, 8.11],
      p89: [null, null, null],
      lastAdjust: { date: '2026-11-13', p92: -0.52, p95: -0.55, p98: -0.55, p0: -0.54 },
    },
    浙江省: {
      regionId: 12,
      p92: [8.29, 8.57, 8.05],
      p95: [8.84, 9.13, 8.6],
      p98: [10.46, 10.75, 10.22],
      p0: [8.04, 8.32, 7.8],
      p89: [null, null, null],
      lastAdjust: { date: '2026-11-13', p92: -0.52, p95: -0.53, p98: -0.53, p0: -0.52 },
    },
  },
  crudeDaily: { brent: [['2026-11-10', 90.1], ['2026-11-13', 89.8]] },
};

const BASE_STATE = { regionKey: 'national', grades: ['p92'], rangeKey: 'month', overlay: true };

test('deriveView 全国均价：当前价取最新窗口', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.cards.p92.price, 8.42);
});

test('deriveView 全国均价：涨跌幅取最近一次调价', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.cards.p92.delta, -0.52);
  assert.equal(view.cards.p92.date, '2026-11-13');
});

test('deriveView 切到省份后用该省数据', () => {
  const view = deriveView(SNAPSHOT, { ...BASE_STATE, regionKey: '北京市' }, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.cards.p92.price, 8.37);
  assert.equal(view.regionName, '北京市');
});

test('deriveView 多选标号时给出多条序列', () => {
  const view = deriveView(SNAPSHOT, { ...BASE_STATE, grades: ['p92', 'p95'] }, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.points.length, 2);
  assert.deepEqual(view.points.map((p) => p.grade), ['p92', 'p95']);
  assert.equal(view.points[0].values.at(-1)[1], 8.42);
});

test('deriveView 该省没有 89 号时价格为 null 并给出提示', () => {
  const view = deriveView(SNAPSHOT, { ...BASE_STATE, regionKey: '北京市', grades: ['p89'] }, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.cards.p89.price, null);
  assert.match(view.emptyMessage, /89/);
});

test('deriveView 区间内没有调价时提示"本区间无调价"', () => {
  const view = deriveView(SNAPSHOT, { ...BASE_STATE, rangeKey: 'week' }, new Date('2026-11-26T12:00:00+08:00'));
  assert.match(view.emptyMessage, /本区间无调价/);
});

test('deriveView 区间内有调价时不提示空态', () => {
  const view = deriveView(SNAPSHOT, { ...BASE_STATE, rangeKey: 'year' }, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.emptyMessage, '');
});

test('deriveView 快照超过六小时判为过期', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-27T12:00:00+08:00'));
  assert.equal(view.stale, true);
});

test('deriveView 快照新鲜时不判过期', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.stale, false);
});

test('deriveView 叠加开关关闭时不返回原油序列', () => {
  const view = deriveView(SNAPSHOT, { ...BASE_STATE, overlay: false }, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.overlay.length, 0);
});

test('deriveView 叠加开关开启时返回区间内的原油序列', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.ok(view.overlay.length > 0);
  assert.equal(view.overlay[0].length, 2);
});

test('deriveView 产出的序列形状能被图表模块直接消费', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.ok(Array.isArray(view.points[0].values));
  const scales = buildScales({ series: view.points, overlay: view.overlay, width: 400, height: 240 });
  assert.ok(scales.ticks.length >= 2);
  assert.equal(typeof scales.y, 'function');
});

test('deriveView 给出数据时间文案', () => {
  const view = deriveView(SNAPSHOT, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.match(view.metaText, /数据更新于/);
});

const LIVE_ROWS = [
  { regionId: 2, regionName: '北京市', date: '2026-11-13', n89: 0, n92: 8.37, n95: 8.91, n98: 10.41, n0: 8.11 },
  { regionId: 12, regionName: '浙江省', date: '2026-11-13', n89: 6.6, n92: 8.05, n95: 8.6, n98: 10.22, n0: 7.8 },
  { regionId: 2, regionName: '北京市', date: '2026-10-30', n89: 0, n92: 8.89, n95: 9.46, n98: 10.96, n0: 8.65 },
  { regionId: 12, regionName: '浙江省', date: '2026-10-30', n89: 6.6, n92: 8.57, n95: 9.13, n98: 10.75, n0: 8.32 },
];

test('applyLiveUpdate: 实时替换后涨跌徽标仍然显示（delta 不能丢）', () => {
  const merged = applyLiveUpdate(SNAPSHOT, LIVE_ROWS, '2026-11-26T20:00:00+08:00');
  const view = deriveView(merged, BASE_STATE, new Date('2026-11-26T21:00:00+08:00'));
  assert.equal(view.cards.p92.price, 8.21);
  assert.equal(view.cards.p92.delta, -0.52);
  assert.equal(view.cards.p92.date, '2026-11-13');
});

test('applyLiveUpdate: 各省与全国均价都被重建', () => {
  const merged = applyLiveUpdate(SNAPSHOT, LIVE_ROWS, '2026-11-26T20:00:00+08:00');
  assert.equal(merged.regions['北京市'].p92.at(-1), 8.37);
  assert.equal(merged.national.p92.at(-1), 8.21);
  assert.ok(merged.national.lastAdjust, '全国 lastAdjust 也要有');
});

test('applyLiveUpdate: 原油日线序列被保留（周视图的唯一波动信号）', () => {
  const merged = applyLiveUpdate(SNAPSHOT, LIVE_ROWS, '2026-11-26T20:00:00+08:00');
  assert.deepEqual(merged.crudeDaily.brent, [['2026-11-10', 90.1], ['2026-11-13', 89.8]]);
});

test('applyLiveUpdate: 旧快照独有的历史窗口不丢（累积历史）', () => {
  const withHistory = JSON.parse(JSON.stringify(SNAPSHOT));
  withHistory.dates = ['2025-06-01', ...withHistory.dates];
  for (const region of [withHistory.national, ...Object.values(withHistory.regions)]) {
    for (const grade of ['p92', 'p95', 'p98', 'p0', 'p89']) {
      region[grade] = [region[grade][0], ...region[grade]];
    }
  }
  const merged = applyLiveUpdate(withHistory, LIVE_ROWS, '2026-11-26T20:00:00+08:00');
  assert.ok(merged.dates.includes('2025-06-01'), '旧历史窗口应保留');
  assert.equal(merged.dates.length, withHistory.dates.length);
});

test('deriveView: lastAdjust 缺失时回退到逐档计算', () => {
  const noAdjust = JSON.parse(JSON.stringify(SNAPSHOT));
  noAdjust.national.lastAdjust = null;
  noAdjust.regions['北京市'].lastAdjust = null;
  const view = deriveView(noAdjust, BASE_STATE, new Date('2026-11-26T12:00:00+08:00'));
  assert.equal(view.cards.p92.delta, -0.52);
  assert.equal(view.cards.p95.delta, -0.52);
});

test('matchRegionName: ipinfo 英文省名映射到快照里的中文名', () => {
  const names = Object.keys(SNAPSHOT.regions);
  assert.equal(matchRegionName('Beijing', names), '北京市');
  assert.equal(matchRegionName('Zhejiang', names), '浙江省');
  assert.equal(matchRegionName('Inner Mongolia', names), null, '快照里没有内蒙古时应返回 null');
});

test('matchRegionName: 易混省名不串（山西/陕西、广西/广东）', () => {
  const names = ['山西省', '陕西省', '广东省', '广西'];
  assert.equal(matchRegionName('Shanxi', names), '山西省');
  assert.equal(matchRegionName('Shaanxi', names), '陕西省');
  assert.equal(matchRegionName('Guangxi', names), '广西');
  assert.equal(matchRegionName('Guangdong', names), '广东省');
});

test('matchRegionName: 无匹配时返回 null', () => {
  assert.equal(matchRegionName('California', ['北京市', '浙江省']), null);
  assert.equal(matchRegionName('', ['北京市']), null);
});

test('matchRegionName: 中文输入直接匹配', () => {
  assert.equal(matchRegionName('北京市', ['北京市', '浙江省']), '北京市');
});
