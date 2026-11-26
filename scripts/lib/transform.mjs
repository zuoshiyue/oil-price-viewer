/**
 * 数据转换纯函数库：把上游原始行转成契约化快照。
 *
 * 上游事实（2026-11-26 实测）：
 * - 主价格表 31 省 × 47 个调价窗口，各省日期集合完全一致。
 * - 价格相邻差值与上游 `*Change` 字段逐行一致 → 涨跌幅由价格相减得出，无需存 Change。
 * - "不调价"窗口上游照样写一行且涨跌全 0 → lastAdjust 必须跳过价格未变化的窗口。
 * - n89/n10/n20/n35 存在 0 与 null 混用的哨兵值 → 一律归一为 null。
 */

export const GRADES = ['p92', 'p95', 'p98', 'p0', 'p89'];

export const SOURCE_FIELDS = { p89: 'n89', p92: 'n92', p95: 'n95', p98: 'n98', p0: 'n0' };

/** 用于判定"最近一次调价"的标号（89 号覆盖不全，不参与锚定）。 */
const ANCHOR_GRADES = ['p92', 'p95', 'p98', 'p0'];

const SOURCES = [
  { name: '金投网 cngold 城市油价', url: 'https://quote.cngold.org/oil/youjia.html' },
  { name: '金投网 jijinhao 行情', url: 'https://quote.cngold.org/' },
  { name: '腾讯财经 外盘期货', url: 'https://qt.gtimg.cn/q=hf_CL,hf_OIL' },
];

const PRICE_BASIS = '发改委挂牌价（生效日口径），非加油站成交价';

/** 保留两位小数，规避浮点半数舍入误差。 */
function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 哨兵值归一：0 / null / 非数字 / 非正数 → null。
 * 89 号与 0 号等主标号同样把 0 视为脏数据（上游 0 表示"该省无此标号"）。
 */
export function sentinelToNull(value, grade) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  void grade;
  return num;
}

/**
 * 把上游行归一为 { dates, regions }。
 * regions[省名] = { regionId, prices: { p92:[...], ... } }，数组按 dates 对齐。
 */
export function normalizeRows(rows) {
  const dateSet = new Set();
  for (const row of rows) {
    if (row && row.date) dateSet.add(row.date);
  }
  const dates = [...dateSet].sort();

  const byRegion = new Map();
  for (const row of rows) {
    if (!row || !row.regionName || !row.date) continue;
    if (!byRegion.has(row.regionName)) {
      byRegion.set(row.regionName, { regionId: row.regionId, prices: {} });
    }
    const region = byRegion.get(row.regionName);
    const idx = dates.indexOf(row.date);
    for (const grade of GRADES) {
      const field = SOURCE_FIELDS[grade];
      if (!region.prices[grade]) region.prices[grade] = new Array(dates.length).fill(null);
      region.prices[grade][idx] = sentinelToNull(row[field], grade);
    }
  }

  const regions = {};
  for (const [name, region] of byRegion) {
    const prices = {};
    for (const grade of GRADES) {
      prices[grade] = region.prices[grade] ?? new Array(dates.length).fill(null);
    }
    regions[name] = { regionId: region.regionId, prices };
  }
  return { dates, regions };
}

/**
 * 找出某个标号序列里最后一次"价格发生变化"的下标。
 * 找不到（序列全平或缺少可比较的相邻值）返回 -1。
 */
function lastChangeIndex(series) {
  if (!Array.isArray(series)) return -1;
  for (let i = series.length - 1; i >= 1; i -= 1) {
    const cur = series[i];
    const prev = series[i - 1];
    if (cur === null || cur === undefined || prev === null || prev === undefined) continue;
    if (cur !== prev) return i;
  }
  return -1;
}

/**
 * 最近一次真实调价：日期取各锚定标号最后变化下标的最大值，
 * 各标号幅度按该下标与前一窗口相减（缺前值则为 null）。
 */
export function computeLastAdjust(pricesByGrade, dates) {
  const anchorGrades = ANCHOR_GRADES.filter((g) => pricesByGrade && pricesByGrade[g]);
  if (!anchorGrades.length) return null;

  let anchor = -1;
  for (const grade of anchorGrades) {
    const idx = lastChangeIndex(pricesByGrade[grade]);
    if (idx > anchor) anchor = idx;
  }
  if (anchor < 1) return null;

  const result = { date: dates[anchor] };
  for (const grade of ANCHOR_GRADES) {
    const series = pricesByGrade[grade];
    const cur = series?.[anchor];
    const prev = series?.[anchor - 1];
    if (cur === null || cur === undefined || prev === null || prev === undefined) {
      result[grade] = null;
    } else {
      result[grade] = round2(cur - prev);
    }
  }
  return result;
}

/**
 * 全国参考均价：31 省算术平均；某省该标号为 null 时该省不参与；
 * 一个省都没有时该点为 null（不是 0）。
 */
export function nationalAverage(regions) {
  const names = Object.keys(regions);
  const dates = names.length ? Object.values(regions)[0].prices.p92.length : 0;
  const result = {};
  for (const grade of GRADES) {
    const series = [];
    for (let i = 0; i < dates; i += 1) {
      let sum = 0;
      let count = 0;
      for (const name of names) {
        const value = regions[name].prices?.[grade]?.[i];
        if (value === null || value === undefined) continue;
        sum += value;
        count += 1;
      }
      series.push(count ? round2(sum / count) : null);
    }
    result[grade] = series;
  }
  return result;
}

/**
 * 取某个省某个标号的序列，兼容两种形状：
 * - 内部归一形状 `{ prices: { p92: [...] } }`
 * - 已落盘的快照形状 `{ p92: [...] }`
 */
function seriesOf(region, grade) {
  if (!region) return null;
  if (region.prices && Array.isArray(region.prices[grade])) return region.prices[grade];
  if (Array.isArray(region[grade])) return region[grade];
  return null;
}

/**
 * 合并历史：新旧快照日期取并集升序，同日以新数据为准，旧快照独有的日期与取值保留。
 * 返回的每个省每个标号数组长度都等于 dates.length。
 */
export function mergeHistory(existing, incoming) {
  const dateSet = new Set();
  if (existing?.dates) for (const d of existing.dates) dateSet.add(d);
  if (incoming?.dates) for (const d of incoming.dates) dateSet.add(d);
  const dates = [...dateSet].sort();

  const names = new Set();
  if (existing?.regions) for (const name of Object.keys(existing.regions)) names.add(name);
  if (incoming?.regions) for (const name of Object.keys(incoming.regions)) names.add(name);

  const regions = {};
  for (const name of names) {
    const oldRegion = existing?.regions?.[name];
    const newRegion = incoming?.regions?.[name];
    const prices = {};
    for (const grade of GRADES) {
      const merged = new Array(dates.length).fill(null);
      const newSeries = seriesOf(newRegion, grade);
      const oldSeries = seriesOf(oldRegion, grade);
      dates.forEach((date, i) => {
        const newIdx = incoming?.dates ? incoming.dates.indexOf(date) : -1;
        if (newIdx >= 0 && newSeries) {
          const fromNew = newSeries[newIdx];
          if (fromNew !== null && fromNew !== undefined) {
            merged[i] = fromNew;
            return;
          }
        }
        const oldIdx = existing?.dates ? existing.dates.indexOf(date) : -1;
        const fromOld = oldIdx >= 0 && oldSeries ? oldSeries[oldIdx] : null;
        merged[i] = fromOld === undefined ? null : fromOld;
      });
      prices[grade] = merged;
    }
    regions[name] = {
      regionId: newRegion?.regionId ?? oldRegion?.regionId ?? null,
      prices,
    };
  }
  return { dates, regions };
}

/** 只保留最近 N 条原油日线，控制快照体积。 */
export function sliceCrude(daily, days = 400) {
  if (!Array.isArray(daily)) return [];
  return daily.length > days ? daily.slice(daily.length - days) : daily.slice();
}

/**
 * 组装契约化快照。
 * input: { rows, nearTime, crude, crudeDaily, existing, generatedAt }
 */
export function buildSnapshot({ rows, nearTime, crude, crudeDaily, existing = null, generatedAt }) {
  const incoming = normalizeRows(rows ?? []);
  const merged = mergeHistory(existing, incoming);
  const { dates, regions } = merged;

  const nationalPrices = nationalAverage(regions);
  const national = {
    ...nationalPrices,
    lastAdjust: computeLastAdjust(nationalPrices, dates),
  };

  const outRegions = {};
  for (const [name, region] of Object.entries(regions)) {
    outRegions[name] = {
      regionId: region.regionId,
      p92: region.prices.p92,
      p95: region.prices.p95,
      p98: region.prices.p98,
      p0: region.prices.p0,
      p89: region.prices.p89,
      lastAdjust: computeLastAdjust(region.prices, dates),
    };
  }

  const lastDate = dates.length ? dates[dates.length - 1] : null;
  return {
    meta: {
      generatedAt,
      schemaVersion: 2,
      sources: SOURCES,
      lastWindow: { date: nearTime?.lastWindow?.date ?? lastDate },
      nextWindow: nearTime?.nextWindow
        ? {
            date: nearTime.nextWindow.date,
            gasolineChange: nearTime.nextWindow.gasolineChange ?? null,
            dieselChange: nearTime.nextWindow.dieselChange ?? null,
          }
        : null,
      crude: crude
        ? {
            wti: crude.wti ?? null,
            brent: crude.brent ?? null,
            wtiChange: crude.wtiChange ?? null,
            brentChange: crude.brentChange ?? null,
            time: crude.time ?? null,
          }
        : null,
      notes: { priceBasis: PRICE_BASIS },
    },
    dates,
    national,
    regions: outRegions,
    crudeDaily: { brent: sliceCrude(crudeDaily ?? []) },
  };
}
