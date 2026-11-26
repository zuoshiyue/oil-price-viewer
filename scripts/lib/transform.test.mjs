import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADES,
  SOURCE_FIELDS,
  normalizeRows,
  sentinelToNull,
  computeLastAdjust,
  nationalAverage,
  mergeHistory,
  sliceCrude,
  buildSnapshot,
} from './transform.mjs';

const ROWS = [
  { regionId: 2, regionName: '北京市', date: '2026-10-16', n89: 0, n92: 8.61, n95: 9.17, n98: 10.67, n0: 8.36, n92Change: 0 },
  { regionId: 2, regionName: '北京市', date: '2026-10-30', n89: 0, n92: 8.89, n95: 9.46, n98: 10.96, n0: 8.65, n92Change: 0.28 },
  { regionId: 2, regionName: '北京市', date: '2026-11-13', n89: 6.61, n92: 8.37, n95: 8.91, n98: 10.41, n0: 8.11, n92Change: -0.52 },
  { regionId: 12, regionName: '浙江省', date: '2026-10-16', n89: 6.4, n92: 8.29, n95: 8.84, n98: 10.46, n0: 8.04, n92Change: 0 },
  { regionId: 12, regionName: '浙江省', date: '2026-10-30', n89: 6.4, n92: 8.57, n95: 9.13, n98: 10.75, n0: 8.32, n92Change: 0.28 },
  { regionId: 12, regionName: '浙江省', date: '2026-11-13', n89: 6.4, n92: 8.05, n95: 8.6, n98: 10.22, n0: 7.8, n92Change: -0.52 },
];

const DATES = ['2026-10-16', '2026-10-30', '2026-11-13'];

const GRADE_SERIES = (overrides = {}) => ({
  p92: [8.61, 8.89, 8.37],
  p95: [9.17, 9.46, 8.91],
  p98: [10.67, 10.96, 10.41],
  p0: [8.36, 8.65, 8.11],
  p89: [null, null, 6.61],
  ...overrides,
});

test('GRADES 覆盖 92/95/98/0/89 五个标号', () => {
  assert.deepEqual([...GRADES], ['p92', 'p95', 'p98', 'p0', 'p89']);
});

test('SOURCE_FIELDS 映射到上游字段名', () => {
  assert.deepEqual(SOURCE_FIELDS, { p89: 'n89', p92: 'n92', p95: 'n95', p98: 'n98', p0: 'n0' });
});

test('sentinelToNull: 89 号的 0 哨兵转 null', () => {
  assert.equal(sentinelToNull(0, 'p89'), null);
});

test('sentinelToNull: 89 号的真实值保留', () => {
  assert.equal(sentinelToNull(6.4, 'p89'), 6.4);
});

test('sentinelToNull: null 输入返回 null', () => {
  assert.equal(sentinelToNull(null, 'p92'), null);
});

test('sentinelToNull: 92 号真实值保留', () => {
  assert.equal(sentinelToNull(8.37, 'p92'), 8.37);
});

test('sentinelToNull: 92 号的 0 视为脏数据转 null', () => {
  assert.equal(sentinelToNull(0, 'p92'), null);
});

test('sentinelToNull: 非数字输入返回 null', () => {
  assert.equal(sentinelToNull('abc', 'p92'), null);
});

test('sentinelToNull: undefined 输入返回 null', () => {
  assert.equal(sentinelToNull(undefined, 'p95'), null);
});

test('normalizeRows: 日期轴升序去重', () => {
  const { dates } = normalizeRows(ROWS);
  assert.deepEqual(dates, DATES);
});

test('normalizeRows: 89 号的 0 哨兵在序列中转 null', () => {
  const { regions } = normalizeRows(ROWS);
  assert.deepEqual(regions['北京市'].prices.p89, [null, null, 6.61]);
});

test('normalizeRows: 92 号序列按日期轴对齐', () => {
  const { regions } = normalizeRows(ROWS);
  assert.deepEqual(regions['北京市'].prices.p92, [8.61, 8.89, 8.37]);
});

test('normalizeRows: 保留 regionId', () => {
  const { regions } = normalizeRows(ROWS);
  assert.equal(regions['北京市'].regionId, 2);
  assert.equal(regions['浙江省'].regionId, 12);
});

test('normalizeRows: 缺失某省某日的行时该位置为 null', () => {
  const { dates, regions } = normalizeRows([...ROWS, { regionId: 12, regionName: '浙江省', date: '2026-11-13', n92: 8.05 }]);
  assert.deepEqual(dates, DATES);
  assert.deepEqual(regions['浙江省'].prices.p92, [8.29, 8.57, 8.05]);
  assert.equal(regions['浙江省'].prices.p95[2], null);
});

test('computeLastAdjust: 返回最近一次调价的日期与各标号幅度', () => {
  const adj = computeLastAdjust(GRADE_SERIES(), DATES);
  assert.equal(adj.date, '2026-11-13');
  assert.equal(adj.p92, -0.52);
  assert.equal(adj.p95, -0.55);
  assert.equal(adj.p98, -0.55);
  assert.equal(adj.p0, -0.54);
});

test('computeLastAdjust: 最近窗口价格未变时取更早的那次调价', () => {
  const adj = computeLastAdjust(GRADE_SERIES({ p92: [8.29, 8.61, 8.61], p95: [8.84, 9.17, 9.17], p98: [10.46, 10.67, 10.67], p0: [8.04, 8.36, 8.36] }), DATES);
  assert.equal(adj.date, '2026-10-30');
  assert.equal(adj.p92, 0.32);
});

test('computeLastAdjust: 夹在中间的不调价窗口不会被当成最近调价日', () => {
  const adj = computeLastAdjust(GRADE_SERIES({ p92: [8.61, 8.61, 8.89], p95: [9.17, 9.17, 9.46], p98: [10.67, 10.67, 10.96], p0: [8.36, 8.36, 8.65] }), DATES);
  assert.equal(adj.date, '2026-11-13');
  assert.equal(adj.p92, 0.28);
});

test('computeLastAdjust: 全部窗口价格未变时返回 null', () => {
  const adj = computeLastAdjust(GRADE_SERIES({ p92: [8.61, 8.61, 8.61], p95: [9.17, 9.17, 9.17], p98: [10.67, 10.67, 10.67], p0: [8.36, 8.36, 8.36] }), DATES);
  assert.equal(adj, null);
});

test('computeLastAdjust: 没有相邻可比较的非空值时返回 null', () => {
  const adj = computeLastAdjust(GRADE_SERIES({ p92: [null, null, 8.37], p95: [null, null, 8.91], p98: [null, null, 10.41], p0: [null, null, 8.11] }), DATES);
  assert.equal(adj, null);
});

test('computeLastAdjust: 某标号缺前值时该标号幅度为 null', () => {
  const adj = computeLastAdjust(GRADE_SERIES({ p95: [null, null, 8.91] }), DATES);
  assert.equal(adj.date, '2026-11-13');
  assert.equal(adj.p95, null);
  assert.equal(adj.p92, -0.52);
});

test('nationalAverage: 92 号按省份算术平均', () => {
  const { regions } = normalizeRows(ROWS);
  assert.deepEqual(nationalAverage(regions).p92, [8.45, 8.73, 8.21]);
});

test('nationalAverage: 89 号跳过无值省份（北京前两窗为 null）', () => {
  const { regions } = normalizeRows(ROWS);
  const p89 = nationalAverage(regions).p89;
  assert.equal(p89[0], 6.4);
  assert.equal(p89[1], 6.4);
  assert.equal(p89[2], 6.51);
});

test('nationalAverage: 某标号全体缺失时该点为 null 而不是 0', () => {
  const regions = {
    北京市: { regionId: 2, prices: { p92: [8.61], p95: [9.17], p98: [10.67], p0: [8.36], p89: [null] } },
  };
  const avg = nationalAverage(regions);
  assert.equal(avg.p89[0], null);
  assert.equal(avg.p92[0], 8.61);
});

test('mergeHistory: 没有旧快照时原样返回新数据', () => {
  const incoming = normalizeRows(ROWS);
  const merged = mergeHistory(null, incoming);
  assert.deepEqual(merged.dates, DATES);
  assert.deepEqual(merged.regions['北京市'].prices.p92, [8.61, 8.89, 8.37]);
});

test('mergeHistory: 日期取并集并保持升序', () => {
  const incoming = normalizeRows(ROWS);
  const existing = { dates: ['2026-01-05'], regions: {} };
  const merged = mergeHistory(existing, incoming);
  assert.deepEqual(merged.dates, ['2026-01-05', ...DATES]);
});

test('mergeHistory: 同一天以新数据为准', () => {
  const incoming = normalizeRows(ROWS);
  const existing = {
    dates: ['2026-10-16'],
    regions: { 北京市: { regionId: 2, prices: { p92: [7.11], p95: [7.11], p98: [7.11], p0: [7.11], p89: [null] } } },
  };
  const merged = mergeHistory(existing, incoming);
  const idx = merged.dates.indexOf('2026-10-16');
  assert.equal(merged.regions['北京市'].prices.p92[idx], 8.61);
});

test('mergeHistory: 旧快照独有的日期与取值被保留（累积历史不丢点）', () => {
  const incoming = { dates: ['2026-11-13'], regions: { 北京市: { regionId: 2, prices: { p92: [8.37], p95: [8.91], p98: [10.41], p0: [8.11], p89: [6.61] } } } };
  const existing = {
    dates: ['2026-01-05'],
    regions: { 北京市: { regionId: 2, prices: { p92: [7.11], p95: [7.55], p98: [8.9], p0: [6.8], p89: [null] } } },
  };
  const merged = mergeHistory(existing, incoming);
  assert.deepEqual(merged.dates, ['2026-01-05', '2026-11-13']);
  assert.equal(merged.regions['北京市'].prices.p92[0], 7.11);
  assert.equal(merged.regions['北京市'].prices.p92[1], 8.37);
});

test('mergeHistory: 合并后每个省的每个标号数组长度等于日期轴长度', () => {
  const incoming = normalizeRows(ROWS);
  const existing = { dates: ['2026-01-05'], regions: {} };
  const merged = mergeHistory(existing, incoming);
  for (const region of Object.values(merged.regions)) {
    for (const grade of GRADES) {
      assert.equal(region.prices[grade].length, merged.dates.length, `${grade} 长度不匹配`);
    }
  }
});

test('mergeHistory: 旧快照没有的省份被保留', () => {
  const incoming = { dates: ['2026-11-13'], regions: { 北京市: { regionId: 2, prices: { p92: [8.37], p95: [8.91], p98: [10.41], p0: [8.11], p89: [6.61] } } } };
  const existing = {
    dates: ['2026-01-05'],
    regions: { 浙江省: { regionId: 12, prices: { p92: [7.2], p95: [7.7], p98: [9.1], p0: [6.9], p89: [null] } } },
  };
  const merged = mergeHistory(existing, incoming);
  assert.ok(merged.regions['浙江省']);
  assert.ok(merged.regions['北京市']);
  assert.equal(merged.regions['浙江省'].prices.p92.length, 2);
  assert.equal(merged.regions['浙江省'].prices.p92[0], 7.2);
  assert.equal(merged.regions['浙江省'].prices.p92[1], null);
});

test('sliceCrude: 条数不足时原样返回', () => {
  const daily = [['2026-01-01', 1], ['2026-01-02', 2]];
  assert.deepEqual(sliceCrude(daily, 400), daily);
});

test('sliceCrude: 只保留最后 N 条', () => {
  const daily = Array.from({ length: 10 }, (_, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, i]);
  assert.deepEqual(sliceCrude(daily, 3), [['2026-01-08', 7], ['2026-01-09', 8], ['2026-01-10', 9]]);
});

test('buildSnapshot: 输出契约字段齐全', () => {
  const snapshot = buildSnapshot({
    rows: ROWS,
    nearTime: { lastWindow: { date: '2026-11-13' }, nextWindow: { date: '2026-11-27', gasolineChange: -440, dieselChange: -425 } },
    crude: { wti: 84.13, brent: 90.87, wtiChange: 0.54, brentChange: 0.25, time: '2026-11-26 16:20:00' },
    crudeDaily: [['2026-11-25', 90.5], ['2026-11-26', 90.87]],
    existing: null,
    generatedAt: '2026-11-26T08:20:11+08:00',
  });
  assert.equal(snapshot.meta.schemaVersion, 2);
  assert.equal(snapshot.meta.generatedAt, '2026-11-26T08:20:11+08:00');
  assert.equal(snapshot.meta.lastWindow.date, '2026-11-13');
  assert.equal(snapshot.meta.nextWindow.date, '2026-11-27');
  assert.equal(snapshot.meta.nextWindow.gasolineChange, -440);
  assert.equal(snapshot.meta.crude.brent, 90.87);
  assert.equal(snapshot.meta.sources.length, 3);
  assert.deepEqual(snapshot.dates, DATES);
  assert.deepEqual(snapshot.national.p92, [8.45, 8.73, 8.21]);
  assert.equal(snapshot.national.lastAdjust.p92, -0.52);
  assert.equal(snapshot.regions['北京市'].lastAdjust.date, '2026-11-13');
  assert.deepEqual(snapshot.crudeDaily.brent, [['2026-11-25', 90.5], ['2026-11-26', 90.87]]);
  assert.equal(snapshot.meta.notes.priceBasis, '发改委挂牌价（生效日口径），非加油站成交价');
});

test('buildSnapshot: 与旧快照合并后保留旧历史', () => {
  const existing = buildSnapshot({
    rows: [{ regionId: 2, regionName: '北京市', date: '2026-01-05', n89: 0, n92: 7.11, n95: 7.55, n98: 8.9, n0: 6.8 }],
    nearTime: { lastWindow: { date: '2026-01-05' }, nextWindow: null },
    crude: null,
    crudeDaily: [],
    existing: null,
    generatedAt: '2026-01-05T10:00:00+08:00',
  });
  const snapshot = buildSnapshot({
    rows: ROWS,
    nearTime: { lastWindow: { date: '2026-11-13' }, nextWindow: null },
    crude: null,
    crudeDaily: [],
    existing,
    generatedAt: '2026-11-26T08:20:11+08:00',
  });
  assert.deepEqual(snapshot.dates, ['2026-01-05', ...DATES]);
  assert.equal(snapshot.regions['北京市'].p92[0], 7.11);
});
