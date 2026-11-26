import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshot, pickExisting, runCli } from '../fetch-oil-prices.mjs';

const SCRIPT = fileURLToPath(new URL('../fetch-oil-prices.mjs', import.meta.url));

const ROWS = Array.from({ length: 12 }, (_, i) => ({
  regionId: 2,
  regionName: '北京市',
  date: `2026-01-${String(i + 1).padStart(2, '0')}`,
  n89: 0,
  n92: 8 + i * 0.1,
  n95: 9 + i * 0.1,
  n98: 10 + i * 0.1,
  n0: 7.5 + i * 0.1,
}));

const FAKE_FETCHERS = {
  fetchOilTable: async () => ROWS,
  fetchNearTime: async () => ({
    lastWindow: { date: '2026-01-12' },
    nextWindow: { date: '2026-01-26', gasolineChange: -200, dieselChange: -190 },
  }),
  fetchCrudeSpot: async () => ({ wti: 84.13, brent: 90.87, wtiChange: 0.54, brentChange: 0.25, time: '2026-11-26 16:20:00' }),
  fetchBrentDaily: async () => [['2026-01-11', 90.1], ['2026-01-12', 90.87]],
};

function tmpOut() {
  const dir = mkdtempSync(join(tmpdir(), 'oilcli-'));
  return { dir, out: join(dir, 'oil-prices.json') };
}

test('--help 退出码 0 并说明用法', () => {
  const out = execFileSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(out, /--dry-run/);
  assert.match(out, /--out/);
});

test('validateSnapshot: 正常快照通过', () => {
  const dates = Array.from({ length: 12 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const series = dates.map((_, i) => 8 + i * 0.1);
  const snapshot = {
    dates,
    regions: { 北京市: { regionId: 2, p92: series, p95: series, p98: series, p0: series, p89: series } },
    meta: { lastWindow: { date: dates.at(-1) } },
  };
  assert.equal(validateSnapshot(snapshot, null).ok, true);
});

test('validateSnapshot: 窗口数不足 12 时不通过', () => {
  const snapshot = { dates: ['2026-01-01'], regions: {}, meta: { lastWindow: { date: '2026-01-01' } } };
  const result = validateSnapshot(snapshot, null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /12/);
});

test('validateSnapshot: 上游最新窗口早于既有快照时不通过', () => {
  const snapshot = {
    dates: Array.from({ length: 12 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
    regions: {},
    meta: { lastWindow: { date: '2026-01-12' } },
  };
  const existing = { meta: { lastWindow: { date: '2026-06-01' } } };
  const result = validateSnapshot(snapshot, existing);
  assert.equal(result.ok, false);
  assert.match(result.reason, /回退|早于/);
});

test('validateSnapshot: 区域数组长度与日期轴不一致时不通过', () => {
  const snapshot = {
    dates: Array.from({ length: 12 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
    regions: { 北京市: { regionId: 2, p92: [1, 2] } },
    meta: { lastWindow: { date: '2026-01-12' } },
  };
  const result = validateSnapshot(snapshot, null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /长度/);
});

test('pickExisting: 没有既有快照时返回 null', () => {
  assert.equal(pickExisting(null, { dates: [], regions: {} }), null);
});

test('pickExisting: schemaVersion 不一致时丢弃既有快照', () => {
  const existing = { meta: { schemaVersion: 1 }, dates: ['2026-01-01'], regions: {}, national: { p92: [8.4] } };
  const incoming = { dates: ['2026-01-01'], regions: {}, national: { p92: [8.4] } };
  assert.equal(pickExisting(existing, incoming), null);
});

test('pickExisting: 与上游数值一致的既有快照被保留', () => {
  const existing = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-01', '2026-01-02'],
    national: { p92: [8.4, 8.5] },
    regions: {},
  };
  const incoming = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-02'],
    national: { p92: [8.5] },
    regions: {},
  };
  assert.equal(pickExisting(existing, incoming), existing);
});

test('pickExisting: 与上游数值冲突的既有快照被丢弃（防脏数据污染历史）', () => {
  const existing = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-01', '2026-01-02'],
    national: { p92: [7.1, 7.2] },
    regions: {},
  };
  const incoming = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-02'],
    national: { p92: [8.5] },
    regions: {},
  };
  assert.equal(pickExisting(existing, incoming), null);
});

test('pickExisting: 与上游没有重叠日期时保留既有快照（历史窗口已滚出上游范围）', () => {
  const existing = {
    meta: { schemaVersion: 2, lastWindow: { date: '2025-06-01' } },
    dates: ['2025-06-01'],
    national: { p92: [7.0] },
    regions: {},
  };
  const incoming = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-02'],
    national: { p92: [8.5] },
    regions: {},
  };
  assert.equal(pickExisting(existing, incoming), existing);
});

test('pickExisting: 单一省份被污染但全国均价几乎不变时也要丢弃', () => {
  // 全国均价几乎没变（只有 1/31 的省份被改），但该省自身数据与上游冲突 → 必须丢弃
  const existing = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-01', '2026-01-02'],
    national: { p92: [8.4, 8.5] },
    regions: { 北京市: { regionId: 2, p92: [8.06, 8.2] } },
  };
  const incoming = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-02'],
    national: { p92: [8.5] },
    regions: { 北京市: { regionId: 2, p92: [8.4] } },
  };
  assert.equal(pickExisting(existing, incoming), null);
});

test('pickExisting: 各省数值都与上游一致时保留既有快照', () => {
  const existing = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-01', '2026-01-02'],
    national: { p92: [8.4, 8.5] },
    regions: { 北京市: { regionId: 2, p92: [8.3, 8.4] } },
  };
  const incoming = {
    meta: { schemaVersion: 2, lastWindow: { date: '2026-01-02' } },
    dates: ['2026-01-02'],
    national: { p92: [8.5] },
    regions: { 北京市: { regionId: 2, p92: [8.4] } },
  };
  assert.equal(pickExisting(existing, incoming), existing);
});

test('runCli: 写出快照文件且内容可解析', async () => {
  const { dir, out } = tmpOut();
  try {
    const result = await runCli([], { fetchers: FAKE_FETCHERS, out, generatedAt: '2026-01-13T08:20:11+08:00' });
    assert.equal(result.exitCode, 0);
    assert.ok(existsSync(out));
    const snapshot = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(snapshot.dates.length, 12);
    assert.equal(snapshot.meta.schemaVersion, 2);
    assert.equal(snapshot.meta.nextWindow.date, '2026-01-26');
    assert.ok(snapshot.regions['北京市']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli: --dry-run 不写文件', async () => {
  const { dir, out } = tmpOut();
  try {
    const result = await runCli(['--dry-run'], { fetchers: FAKE_FETCHERS, out, generatedAt: '2026-01-13T08:20:11+08:00' });
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(out), false);
    assert.ok(result.stdout.includes('2026-01-12'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli: 上游回退时保留旧快照且退出码非 0', async () => {
  const { dir, out } = tmpOut();
  try {
    await runCli([], { fetchers: FAKE_FETCHERS, out, generatedAt: '2026-01-13T08:20:11+08:00' });
    const before = readFileSync(out, 'utf8');

    const staleFetchers = {
      ...FAKE_FETCHERS,
      fetchOilTable: async () => ROWS.map((row) => ({ ...row, date: '2025-01-01' })),
      fetchNearTime: async () => ({
        lastWindow: { date: '2025-01-01' },
        nextWindow: { date: '2025-01-15', gasolineChange: -100, dieselChange: -90 },
      }),
    };
    const result = await runCli([], { fetchers: staleFetchers, out, generatedAt: '2026-01-13T08:20:11+08:00' });
    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(out, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli: 主价格表抓取失败时不写文件', async () => {
  const { dir, out } = tmpOut();
  try {
    const failing = { ...FAKE_FETCHERS, fetchOilTable: async () => { throw new Error('上游 405'); } };
    const result = await runCli([], { fetchers: failing, out, generatedAt: '2026-01-13T08:20:11+08:00' });
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli: 辅助端点失败不致命，快照仍然写出', async () => {
  const { dir, out } = tmpOut();
  try {
    const partial = {
      ...FAKE_FETCHERS,
      fetchNearTime: async () => { throw new Error('near_time 挂了'); },
      fetchBrentDaily: async () => { throw new Error('日 K 挂了'); },
    };
    const result = await runCli([], { fetchers: partial, out, generatedAt: '2026-01-13T08:20:11+08:00' });
    assert.equal(result.exitCode, 0);
    const snapshot = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(snapshot.meta.nextWindow, null);
    assert.deepEqual(snapshot.crudeDaily.brent, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
