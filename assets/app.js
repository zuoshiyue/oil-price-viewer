/**
 * 页面装配：加载快照 → 筛选 → 渲染卡片与图表 → 实时补齐与容错。
 *
 * deriveView 是纯函数（可在 node 里测），其余部分只在浏览器里跑。
 */

import {
  selectRange,
  sliceSeries,
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
import { renderChart, GRADE_COLORS, GRADE_LABELS } from './chart.js';
// 浏览器直接复用 CI 数据管道（Pages 上都是静态文件，node 测试同源可 import）
import { buildSnapshot } from '../scripts/lib/transform.mjs';
import { fetchOilTable, fetchNearTime, fetchCrudeSpot } from '../scripts/lib/upstream.mjs';

const SNAPSHOT_URL = './data/oil-prices.json';
const IP_GEO = 'https://ipinfo.io/json';
const STALE_HOURS = 6;
const STORAGE_KEY = 'oil-price-viewer:color-scheme';

const CARD_GRADES = ['p92', 'p95', 'p98', 'p0'];

/** ipinfo 的英文省名 → 快照里的中文省名（键必须与 cngold 的 regionName 完全一致）。 */
const REGION_EN_TO_CN = {
  Beijing: '北京市',
  Tianjin: '天津市',
  Shanghai: '上海市',
  Chongqing: '重庆市',
  Hebei: '河北省',
  Shanxi: '山西省',
  'Inner Mongolia': '内蒙古',
  Liaoning: '辽宁省',
  Jilin: '吉林省',
  Heilongjiang: '黑龙江省',
  Jiangsu: '江苏省',
  Zhejiang: '浙江省',
  Anhui: '安徽省',
  Fujian: '福建省',
  Jiangxi: '江西省',
  Shandong: '山东省',
  Henan: '河南省',
  Hubei: '湖北省',
  Hunan: '湖南省',
  Guangdong: '广东省',
  Guangxi: '广西',
  Hainan: '海南省',
  Sichuan: '四川省',
  Guizhou: '贵州省',
  Yunnan: '云南省',
  Tibet: '西藏',
  Shaanxi: '陕西省',
  Gansu: '甘肃省',
  Qinghai: '青海省',
  Ningxia: '宁夏',
  Xinjiang: '新疆',
};

/** 用英文省名（ipinfo）匹配快照里的中文省名，匹配不到返回 null。 */
export function matchRegionName(region, names) {
  if (!region || !Array.isArray(names)) return null;
  const input = String(region).trim();
  if (!input) return null;
  // 中文输入直接匹配
  const direct = names.find((name) => name === input || name.includes(input) || input.includes(name));
  if (direct) return direct;
  // 英文输入查映射表（含易混对：Shanxi=山西 / Shaanxi=陕西）
  const mapped = REGION_EN_TO_CN[input];
  if (mapped && names.includes(mapped)) return mapped;
  return null;
}

/** 把 ISO 时间戳格式化成北京时间字符串。 */
function formatStamp(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * 由快照与界面状态推导出要渲染的内容。
 * state: { regionKey, grades, rangeKey, overlay }
 */
export function deriveView(snapshot, state, now = new Date()) {
  const regionKey = state.regionKey ?? 'national';
  const region = regionKey === 'national' ? snapshot.national : snapshot.regions?.[regionKey];
  const regionName = regionKey === 'national' ? '全国参考均价' : regionKey;
  const grades = Array.isArray(state.grades) && state.grades.length ? state.grades : ['p92'];
  const rangeKey = state.rangeKey ?? 'month';
  const dates = snapshot.dates ?? [];

  const { startIdx, endIdx, rangeStartIdx } = selectRange(dates, rangeKey, now);

  const cards = {};
  for (const grade of [...CARD_GRADES, 'p89']) {
    const series = region?.[grade] ?? [];
    let delta = null;
    let date = null;
    if (grade === 'p89' || !region?.lastAdjust) {
      // 89 号或 lastAdjust 缺失时逐档回退计算（实时补齐路径必须仍有涨跌徽标）
      const adjustment = latestAdjustment(series, dates);
      if (adjustment) {
        delta = adjustment.delta;
        date = adjustment.date;
      }
    } else {
      delta = region.lastAdjust[grade] ?? null;
      date = region.lastAdjust.date ?? null;
    }
    cards[grade] = { price: currentPrice(series), delta, date };
  }

  const points = grades.map((grade) => ({
    grade,
    values: sliceSeries(dates, region?.[grade] ?? [], startIdx, endIdx),
  }));

  const overlay = [];
  if (state.overlay && Array.isArray(snapshot.crudeDaily?.brent)) {
    const cutoff = now.getTime() - (({ week: 7, month: 30, year: 365 })[rangeKey] ?? 30) * 86400000;
    for (const [day, close] of snapshot.crudeDaily.brent) {
      if (parseDateOnly(day).getTime() >= cutoff) overlay.push([day, close]);
    }
  }

  const messages = [];
  const missingGrades = grades.filter((grade) => currentPrice(region?.[grade] ?? []) === null);
  if (missingGrades.length) {
    messages.push(`${missingGrades.map((grade) => GRADE_LABELS[grade] ?? grade).join('、')}在该地区无数据`);
  }
  const hasAnyPoint = points.some((entry) => entry.values.some(([, value]) => value !== null));
  if (!hasAnyPoint) {
    messages.push('所选区间暂无数据');
  } else if (!hasAdjustmentInRange(dates, region?.p92 ?? [], rangeStartIdx, endIdx)) {
    const since = cards.p92.date ?? dates[endIdx] ?? '';
    messages.push(`本区间无调价，当前价自 ${since} 起未变`);
  }

  const stale = isStale(snapshot.meta?.generatedAt, now, STALE_HOURS);
  const metaText = `数据更新于 ${formatStamp(snapshot.meta?.generatedAt)}`;

  return {
    regionKey,
    regionName,
    grades,
    rangeKey,
    cards,
    points,
    overlay,
    emptyMessage: messages.join('；'),
    stale,
    metaText,
  };
}

/**
 * 浏览器实时补齐：上游新行与既有快照合并。
 * 与 CI 的 buildSnapshot 同一条管道 —— 累积历史、原油序列、全国均价、
 * lastAdjust 全部保留或重算，实时刷新不会让页面降级。
 */
export function applyLiveUpdate(existing, rows, generatedAt = new Date().toISOString()) {
  return buildSnapshot({
    rows,
    nearTime: existing?.meta
      ? { lastWindow: existing.meta.lastWindow, nextWindow: existing.meta.nextWindow }
      : null,
    crude: existing?.meta?.crude ?? null,
    crudeDaily: existing?.crudeDaily?.brent ?? [],
    existing,
    generatedAt,
  });
}

/* ------------------------------------------------------------------ */
/* 浏览器部分                                                          */
/* ------------------------------------------------------------------ */

function bootstrap() {
  const dom = {
    metaBar: document.querySelector('#meta-bar'),
    refreshBtn: document.querySelector('#refresh-btn'),
    themeToggle: document.querySelector('#theme-toggle'),
    regionSelect: document.querySelector('#region-select'),
    locateBtn: document.querySelector('#locate-btn'),
    gradeChips: document.querySelector('#grade-chips'),
    rangeTabs: document.querySelector('#range-tabs'),
    overlayToggle: document.querySelector('#overlay-toggle'),
    priceCards: document.querySelector('#price-cards'),
    chart: document.querySelector('#chart'),
    chartEmpty: document.querySelector('#chart-empty'),
    chartTitle: document.querySelector('#chart-title'),
    legend: document.querySelector('#chart-legend'),
    nextWindow: document.querySelector('#next-window'),
    crudeCard: document.querySelector('#crude-card'),
    statusLive: document.querySelector('#status-live'),
    chartCursor: document.querySelector('#chart-cursor'),
    chartTooltip: document.querySelector('#chart-tooltip'),
  };
  if (!dom.chart || !dom.priceCards) return;

  const state = {
    regionKey: 'national',
    grades: ['p92'],
    rangeKey: 'month',
    overlay: true,
  };

  let snapshot = null;
  let liveMode = false;

  const announce = (message) => {
    if (dom.statusLive) dom.statusLive.textContent = message;
  };

  const setMeta = (text, stateName) => {
    if (!dom.metaBar) return;
    dom.metaBar.textContent = text;
    if (stateName) dom.metaBar.dataset.state = stateName;
    else delete dom.metaBar.dataset.state;
  };

  function renderCards(view) {
    const grades = view.grades.includes('p89') ? [...CARD_GRADES, 'p89'] : CARD_GRADES;
    dom.priceCards.replaceChildren();
    for (const grade of grades) {
      const card = view.cards[grade];
      const article = document.createElement('article');
      article.className = 'card';
      article.dataset.grade = grade;

      const title = document.createElement('h3');
      title.className = 'card__title';
      title.textContent = GRADE_LABELS[grade] ?? grade;
      article.append(title);

      const price = document.createElement('p');
      price.className = 'price';
      const value = document.createElement('span');
      value.className = 'price__value';
      value.textContent = formatPrice(card.price);
      const unit = document.createElement('span');
      unit.className = 'price__unit';
      unit.textContent = '元/升';
      price.append(value, unit);
      article.append(price);

      const meta = document.createElement('p');
      meta.className = 'price__meta';
      const delta = document.createElement('span');
      delta.className = `delta delta--${deltaClass(card.delta)}`;
      delta.textContent = formatDelta(card.delta);
      const since = document.createElement('span');
      since.textContent = card.date ? `最近调价 ${card.date}` : '无调价记录';
      meta.append(delta, since);
      article.append(meta);

      dom.priceCards.append(article);
    }
  }

  function renderLegend(view) {
    dom.legend.replaceChildren();
    for (const entry of view.points) {
      const item = document.createElement('span');
      item.className = 'legend__item';
      item.dataset.grade = entry.grade;
      const swatch = document.createElement('span');
      swatch.className = 'legend__swatch';
      const label = document.createElement('span');
      label.textContent = GRADE_LABELS[entry.grade] ?? entry.grade;
      item.append(swatch, label);
      dom.legend.append(item);
    }
    if (view.overlay.length) {
      const item = document.createElement('span');
      item.className = 'legend__item';
      item.dataset.series = 'brent';
      const swatch = document.createElement('span');
      swatch.className = 'legend__swatch';
      const label = document.createElement('span');
      label.textContent = 'Brent 原油（美元/桶，右轴）';
      item.append(swatch, label);
      dom.legend.append(item);
    }
  }

  function hideTooltip() {
    if (dom.chartCursor) dom.chartCursor.hidden = true;
    if (dom.chartTooltip) dom.chartTooltip.hidden = true;
  }

  function showTooltip(offsetX) {
    const model = dom.chart.__chartModel;
    if (!model || !model.paths.length) return;
    const anchor = nearestByX(model.paths[0].markers, offsetX);
    if (!anchor) return;
    const rows = [];
    for (const path of model.paths) {
      const marker = path.markers.find((item) => item.date === anchor.date);
      if (marker) rows.push(`${GRADE_LABELS[path.grade] ?? path.grade} ${formatPrice(marker.value)}`);
    }
    if (dom.chartTooltip) {
      dom.chartTooltip.textContent = rows.length ? `${anchor.date} · ${rows.join(' · ')}` : anchor.date;
      dom.chartTooltip.hidden = false;
    }
    if (dom.chartCursor) {
      dom.chartCursor.style.left = `${anchor.x}px`;
      dom.chartCursor.hidden = false;
    }
  }

  function renderChartFor(view) {
    const rect = dom.chart.getBoundingClientRect();
    const width = Math.max(240, Math.round(rect.width) || 320);
    const height = Math.max(200, Math.round(rect.height) || 260);
    renderChart(dom.chart, {
      series: view.points,
      overlay: view.overlay,
      width,
      height,
    });

    if (dom.chartEmpty) {
      // 有消息就显示（比如"本区间无调价"），没消息才隐藏；不遮住图表本身
      dom.chartEmpty.hidden = !view.emptyMessage;
      dom.chartEmpty.textContent = view.emptyMessage;
    }

    if (dom.chartTitle) {
      dom.chartTitle.textContent = `${view.regionName} · ${view.grades.map((g) => GRADE_LABELS[g] ?? g).join(' / ')}`;
    }

    const first = view.points[0];
    const lastValue = first?.values.at(-1)?.[1] ?? null;
    const label = first
      ? `${view.regionName}，${view.grades.map((g) => GRADE_LABELS[g] ?? g).join('、')}，当前 ${formatPrice(lastValue)} 元/升，区间 ${first.values[0]?.[0] ?? ''} 至 ${first.values.at(-1)?.[0] ?? ''}`
      : '油价走势图';
    dom.chart.setAttribute('aria-label', label);
  }

  function renderExtra(view, extra) {
    const next = extra.nextWindow ?? snapshot?.meta?.nextWindow ?? null;
    if (dom.nextWindow) {
      const content = dom.nextWindow.querySelector('.card__content');
      if (content) {
        if (next) {
          const direction = (next.gasolineChange ?? 0) < 0 ? '下调' : '上调';
          content.textContent = `${next.date} · 汽油${direction} ${Math.abs(next.gasolineChange ?? 0)} 元/吨 · 柴油${direction} ${Math.abs(next.dieselChange ?? 0)} 元/吨`;
        } else {
          content.textContent = '暂无下次调价窗口信息';
        }
      }
    }

    const crude = extra.crude ?? snapshot?.meta?.crude ?? null;
    if (dom.crudeCard) {
      const content = dom.crudeCard.querySelector('.card__content');
      if (content) {
        if (crude) {
          content.textContent = `WTI ${formatPrice(crude.wti)} 美元/桶（${formatDelta(crude.wtiChange)}%）· Brent ${formatPrice(crude.brent)} 美元/桶（${formatDelta(crude.brentChange)}%）`;
        } else {
          content.textContent = '暂无原油行情';
        }
      }
    }
  }

  function render() {
    if (!snapshot) return;
    const view = deriveView(snapshot, state, new Date());
    hideTooltip();
    renderCards(view);
    renderLegend(view);
    renderChartFor(view);
    renderExtra(view, { nextWindow: null, crude: null });
    const metaText = liveMode ? `${view.metaText} · 已实时更新` : view.metaText;
    setMeta(view.stale ? `${metaText} · 数据可能滞后` : metaText, view.stale ? 'stale' : null);
    document.title = `${view.regionName}油价 · ${view.grades.map((g) => GRADE_LABELS[g] ?? g).join('/')} · 油价看板`;
  }

  function populateRegions() {
    const names = Object.keys(snapshot.regions ?? {}).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const existing = new Set([...dom.regionSelect.options].map((option) => option.value));
    for (const name of names) {
      if (existing.has(name)) continue;
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      dom.regionSelect.append(option);
    }
  }

  function readFilters() {
    state.grades = [...dom.gradeChips.querySelectorAll('input[data-grade]:checked')].map((input) => input.value);
    const range = dom.rangeTabs.querySelector('input[data-range]:checked');
    if (range) state.rangeKey = range.value;
    state.overlay = dom.overlayToggle.checked;
  }

  /** 上游主表直连：只在快照过期或用户主动刷新时使用（复用 CI 抓取层，自带重试与截断校验）。 */
  async function fetchLiveTable() {
    return fetchOilTable();
  }

  async function refreshLive({ force = false } = {}) {
    if (!snapshot) {
      // 首次加载都失败了：刷新按钮退化为重新加载页面数据
      await load();
      return;
    }
    if (!force && !deriveView(snapshot, state, new Date()).stale) return;
    setMeta('正在拉取最新数据…');
    try {
      const rows = await fetchLiveTable();
      // 与既有快照合并：累积历史、原油序列、涨跌口径全部保留
      snapshot = applyLiveUpdate(snapshot, rows);
      liveMode = true;
      render();
      announce('已更新到最新油价数据');
    } catch (error) {
      liveMode = false;
      render();
      setMeta(`${deriveView(snapshot, state, new Date()).metaText} · 数据源暂不可用，显示上次快照`, 'error');
      announce('数据源暂不可用，仍显示上次快照');
    }
  }

  async function refreshExtras() {
    const extra = { nextWindow: null, crude: null };
    // 辅助端点直接复用 CI 抓取层（含重试与 GBK 解码），失败时回退快照值
    try {
      const nearTime = await fetchNearTime();
      extra.nextWindow = nearTime?.nextWindow ?? null;
    } catch {
      /* 用快照里的值 */
    }
    try {
      extra.crude = await fetchCrudeSpot();
    } catch {
      /* 用快照里的值 */
    }
    if (snapshot) {
      const view = deriveView(snapshot, state, new Date());
      renderExtra(view, extra);
    }
  }

  async function locateRegion() {
    setMeta('正在定位省份…');
    try {
      const response = await fetch(IP_GEO);
      const info = await response.json();
      // ipinfo 返回英文省名（如 Beijing），需要映射到快照里的中文省名
      const match = matchRegionName(info.region, snapshot ? Object.keys(snapshot.regions) : []);
      if (match) {
        state.regionKey = match;
        dom.regionSelect.value = match;
        render();
        announce(`已切换到 ${match}`);
      } else {
        setMeta('未识别到省份，请手动选择');
        announce('未识别到省份，请手动选择');
      }
    } catch {
      setMeta('定位失败，请手动选择省份');
      announce('定位失败，请手动选择省份');
    }
  }

  function setupThemeToggle() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    dom.themeToggle?.addEventListener('click', () => {
      const current = meta?.content ?? 'light dark';
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const rendered = current === 'light dark' ? (prefersDark ? 'dark' : 'light') : current;
      const target = rendered === 'dark' ? 'light' : 'dark';
      const prefersLight = !prefersDark;
      const next = target === (prefersLight ? 'light' : 'dark') ? 'light dark' : target;
      if (meta) meta.content = next;
      try {
        if (next === 'light dark') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* 存不下就算了，主题仍然生效 */
      }
      announce(next === 'light dark' ? '主题跟随系统' : `已切换到${next === 'dark' ? '深色' : '浅色'}主题`);
    });
  }

  async function load() {
    try {
      const response = await fetch(SNAPSHOT_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      snapshot = await response.json();
      populateRegions();
      render();
      refreshExtras();
      // 快照过期时自动尝试一次实时补齐；正常情况下不做这次大流量拉取
      if (deriveView(snapshot, state, new Date()).stale) refreshLive();
    } catch (error) {
      setMeta(`数据加载失败：${error.message}`, 'error');
      dom.priceCards.replaceChildren();
      const message = document.createElement('p');
      message.className = 'placeholder';
      message.textContent = '暂时无法加载油价数据，请稍后重试。';
      dom.priceCards.append(message);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = '重试';
      retry.addEventListener('click', () => window.location.reload());
      dom.priceCards.append(retry);
    }
  }

  dom.regionSelect?.addEventListener('change', (event) => {
    state.regionKey = event.target.value;
    render();
  });

  dom.gradeChips?.addEventListener('change', () => {
    readFilters();
    render();
  });

  dom.rangeTabs?.addEventListener('change', () => {
    readFilters();
    render();
  });

  dom.overlayToggle?.addEventListener('change', () => {
    readFilters();
    render();
  });

  dom.locateBtn?.addEventListener('click', locateRegion);

  dom.refreshBtn?.addEventListener('click', () => {
    refreshLive({ force: true });
  });

  // 图表十字线与 tooltip
  dom.chart.addEventListener('pointermove', (event) => {
    const rect = dom.chart.getBoundingClientRect();
    showTooltip(event.clientX - rect.left);
  });

  dom.chart.addEventListener('pointerleave', hideTooltip);
  dom.chart.addEventListener('pointercancel', hideTooltip);

  setupThemeToggle();

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (snapshot) renderChartFor(deriveView(snapshot, state, new Date()));
    });
    observer.observe(dom.chart);
  }

  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
}

export { formatStamp, GRADE_COLORS };
