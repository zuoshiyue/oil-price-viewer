#!/usr/bin/env node
/**
 * 抓取 CLI：抓上游 → 校验 → 与历史合并 → 原子写 data/oil-prices.json。
 *
 * 用法：
 *   node scripts/fetch-oil-prices.mjs            # 抓取并写入 data/oil-prices.json
 *   node scripts/fetch-oil-prices.mjs --dry-run  # 只打印摘要，不写文件
 *   node scripts/fetch-oil-prices.mjs --out <path>
 *
 * 失败保护（命中任一 → 不写文件、保留旧快照、退出码非 0）：
 *   1. 上游最新窗口日期早于既有快照（上游回退）
 *   2. 上游窗口数 < 12（历史断裂）
 *   3. 各省数组长度与日期轴长度不一致
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from './lib/transform.mjs';
import {
  fetchOilTable as defaultFetchOilTable,
  fetchNearTime as defaultFetchNearTime,
  fetchCrudeSpot as defaultFetchCrudeSpot,
  fetchBrentDaily as defaultFetchBrentDaily,
} from './lib/upstream.mjs';

const DEFAULT_OUT = 'data/oil-prices.json';

/** 既有快照与上游允许的最大价差（元/升），超出即视为脏数据。 */
const PRICE_TOLERANCE = 0.02;

const USAGE = `用法: node scripts/fetch-oil-prices.mjs [选项]

选项:
  --dry-run      只抓取并打印摘要，不写文件
  --out <path>   输出路径（默认 ${DEFAULT_OUT}）
  --help         显示本帮助
`;

/**
 * 决定既有快照能否作为"累积历史"合并进来。
 * - 没有既有快照 → null
 * - schemaVersion 不一致 → 丢弃（格式不同，不能混用）
 * - 与上游在重叠日期的数值冲突 → 丢弃（防止脏数据把假历史点带进曲线）
 * - 与上游无重叠日期 → 保留（历史窗口已滚出上游范围，无法也不必核对）
 */
export function pickExisting(existing, incomingSnapshot) {
  if (!existing) return null;
  if (existing.meta?.schemaVersion !== 2) return null;

  const existingDates = existing.dates ?? [];
  const incomingDates = incomingSnapshot?.dates ?? [];
  const overlap = incomingDates.filter((date) => existingDates.includes(date));
  if (!overlap.length) return existing;

  const grades = ['p92', 'p95', 'p98', 'p0'];
  const conflict = (oldSeries, newSeries) => {
    if (!Array.isArray(oldSeries) || !Array.isArray(newSeries)) return false;
    for (const date of overlap) {
      const oldValue = oldSeries[existingDates.indexOf(date)];
      const newValue = newSeries[incomingDates.indexOf(date)];
      if (oldValue === null || oldValue === undefined) continue;
      if (newValue === null || newValue === undefined) continue;
      if (Math.abs(oldValue - newValue) > PRICE_TOLERANCE) return true;
    }
    return false;
  };

  // 逐省比对：只看全国均价会漏掉"个别省份被污染"的情况（1/31 的权重几乎不动均值）。
  for (const [name, oldRegion] of Object.entries(existing.regions ?? {})) {
    const newRegion = incomingSnapshot?.regions?.[name];
    if (!newRegion) continue;
    for (const grade of grades) {
      if (conflict(oldRegion?.[grade], newRegion?.[grade])) return null;
    }
  }
  if (conflict(existing.national?.p92, incomingSnapshot?.national?.p92)) return null;
  return existing;
}

/** 快照是否可安全落盘。 */
export function validateSnapshot(snapshot, existing) {
  if (!snapshot || !Array.isArray(snapshot.dates)) {
    return { ok: false, reason: '快照结构非法' };
  }
  if (snapshot.dates.length < 12) {
    return { ok: false, reason: `上游窗口数不足（${snapshot.dates.length} < 12）` };
  }
  const newDate = snapshot.meta?.lastWindow?.date ?? snapshot.dates.at(-1);
  const oldDate = existing?.meta?.lastWindow?.date;
  if (oldDate && newDate && oldDate > newDate) {
    return { ok: false, reason: `上游日期回退：既有 ${oldDate} > 新 ${newDate}` };
  }
  for (const [name, region] of Object.entries(snapshot.regions ?? {})) {
    for (const grade of ['p92', 'p95', 'p98', 'p0', 'p89']) {
      const series = region?.[grade];
      if (!Array.isArray(series) || series.length !== snapshot.dates.length) {
        return { ok: false, reason: `${name} 的 ${grade} 长度与日期轴不一致` };
      }
    }
  }
  return { ok: true };
}

function readExisting(out) {
  if (!existsSync(out)) return null;
  try {
    return JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(out, snapshot) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
  renameSync(tmp, out);
}

function parseArgs(argv, defaultOut = DEFAULT_OUT) {
  const options = { dryRun: false, out: defaultOut, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out 需要一个路径参数');
      options.out = value;
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/**
 * CLI 主流程。
 * fetchers 可注入，便于测试；默认使用真实上游。
 */
export async function runCli(argv, { fetchers = {}, out = DEFAULT_OUT, generatedAt } = {}) {
  const fetchOilTable = fetchers.fetchOilTable ?? defaultFetchOilTable;
  const fetchNearTime = fetchers.fetchNearTime ?? defaultFetchNearTime;
  const fetchCrudeSpot = fetchers.fetchCrudeSpot ?? defaultFetchCrudeSpot;
  const fetchBrentDaily = fetchers.fetchBrentDaily ?? defaultFetchBrentDaily;

  let options;
  try {
    options = parseArgs(argv, out);
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${error.message}\n\n${USAGE}` };
  }
  if (options.help) {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }

  const outPath = options.out;
  const existing = readExisting(outPath);
  const stamp = generatedAt ?? new Date().toISOString();

  let rows;
  try {
    rows = await fetchOilTable();
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `主价格表抓取失败：${error.message}` };
  }

  // 辅助端点失败不致命：保留旧快照里的对应信息即可。
  const [nearTime, crude, crudeDaily] = await Promise.all([
    fetchNearTime().catch(() => existing?.meta?.nextWindow
      ? { lastWindow: existing.meta.lastWindow, nextWindow: existing.meta.nextWindow }
      : null),
    fetchCrudeSpot().catch(() => existing?.meta?.crude ?? null),
    fetchBrentDaily().catch(() => existing?.crudeDaily?.brent ?? []),
  ]);

  // 先用不含历史的上游数据算出基准快照，用来核对既有快照是否可信。
  const baseSnapshot = buildSnapshot({ rows, nearTime, crude, crudeDaily, existing: null, generatedAt: stamp });
  const trustedExisting = pickExisting(existing, baseSnapshot);
  const historyKept = Boolean(trustedExisting);
  const snapshot = buildSnapshot({ rows, nearTime, crude, crudeDaily, existing: trustedExisting, generatedAt: stamp });

  const validation = validateSnapshot(snapshot, existing);
  if (!validation.ok) {
    return { exitCode: 1, stdout: '', stderr: `快照校验未通过：${validation.reason}（保留既有快照）` };
  }

  const summary = [
    `rows=${rows.length}`,
    `dates=${snapshot.dates.length}`,
    `latest=${snapshot.dates.at(-1)}`,
    `provinces=${Object.keys(snapshot.regions).length}`,
    `nextWindow=${snapshot.meta.nextWindow?.date ?? '-'}`,
    `history=${historyKept ? 'kept' : 'discarded'}`,
    `output=${options.dryRun ? '(dry-run, 未写入)' : outPath}`,
  ].join(' ');

  if (options.dryRun) {
    return { exitCode: 0, stdout: `${summary}\n`, stderr: '', snapshot };
  }

  writeAtomic(outPath, snapshot);
  return { exitCode: 0, stdout: `${summary}\n`, stderr: '', snapshot };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
