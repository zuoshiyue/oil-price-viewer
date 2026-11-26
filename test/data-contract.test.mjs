import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const snapshot = JSON.parse(
  readFileSync(new URL('../data/oil-prices.json', import.meta.url), 'utf8'),
);

const GRADES = ['p92', 'p95', 'p98', 'p0', 'p89'];

test('快照版本号符合契约', () => {
  assert.equal(snapshot.meta.schemaVersion, 2);
});

test('覆盖 31 个省份', () => {
  assert.equal(Object.keys(snapshot.regions).length, 31);
});

test('每个省的每个标号序列长度与日期轴一致', () => {
  for (const [name, region] of Object.entries(snapshot.regions)) {
    for (const grade of GRADES) {
      assert.ok(Array.isArray(region[grade]), `${name} 缺 ${grade} 序列`);
      assert.equal(region[grade].length, snapshot.dates.length, `${name} 的 ${grade} 长度不匹配`);
    }
  }
});

test('日期轴严格升序且无重复', () => {
  for (let i = 1; i < snapshot.dates.length; i += 1) {
    assert.ok(snapshot.dates[i] > snapshot.dates[i - 1], `日期未升序：${snapshot.dates[i - 1]} → ${snapshot.dates[i]}`);
  }
  assert.equal(new Set(snapshot.dates).size, snapshot.dates.length);
});

test('所有非空价格落在合理值域内', () => {
  for (const [name, region] of Object.entries(snapshot.regions)) {
    for (const grade of GRADES) {
      for (const value of region[grade]) {
        if (value === null) continue;
        assert.ok(value >= 6 && value <= 13, `${name} 的 ${grade} 出现异常值 ${value}`);
      }
    }
  }
});

test('89 号不存在 0 哨兵残留', () => {
  for (const [name, region] of Object.entries(snapshot.regions)) {
    for (const value of region.p89) {
      if (value === null) continue;
      assert.ok(value > 0, `${name} 的 p89 出现 0 哨兵`);
    }
  }
});

test('全国均价序列长度与日期轴一致', () => {
  for (const grade of GRADES) {
    assert.equal(snapshot.national[grade].length, snapshot.dates.length, `national.${grade} 长度不匹配`);
  }
});

test('全国均价每个点至少有一个省份参与', () => {
  for (const grade of GRADES) {
    for (const value of snapshot.national[grade]) {
      assert.notEqual(value, null, `national.${grade} 出现空点`);
    }
  }
});

test('最近一次调价日期不早于快照里的最新窗口', () => {
  assert.equal(snapshot.national.lastAdjust.date, snapshot.dates.at(-1));
});

test('最新调价窗口在 60 天内（否则需要重跑抓取脚本）', () => {
  const latest = Date.parse(`${snapshot.dates.at(-1)}T00:00:00+08:00`);
  const ageDays = (Date.now() - latest) / 86400000;
  assert.ok(ageDays <= 60, `最新窗口 ${snapshot.dates.at(-1)} 距今 ${ageDays.toFixed(1)} 天，已过期`);
});

test('下次调价窗口日期格式为 YYYY-MM-DD', () => {
  assert.match(snapshot.meta.nextWindow.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('数据源清单完整', () => {
  assert.equal(snapshot.meta.sources.length, 3);
  for (const source of snapshot.meta.sources) {
    assert.ok(source.name);
    assert.match(source.url, /^https:\/\//);
  }
});

test('价格口径说明存在', () => {
  assert.match(snapshot.meta.notes.priceBasis, /发改委挂牌价/);
});
