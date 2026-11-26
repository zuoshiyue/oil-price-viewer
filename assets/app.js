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

const SNAPSHOT_URL = './data/oil-prices.json';
const UPSTREAM_TABLE = 'https://datacenter.cngold.org/city_oil/all_price_by_year/';
const UPSTREAM_NEAR_TIME = 'https://datacenter.cngold.org/city_oil/near_time/';
const UPSTREAM_CRUDE = 'https://qt.gtimg.cn/q=hf_CL,hf_OIL';
const IP_GEO = 'https://ipinfo.io/json';
const STALE_HOURS = 6;
const STORAGE_KEY = 'oil-price-viewer:color-scheme';

const CARD_GRADES = ['p92', 'p95', 'p98', 'p0'];

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
    if (grade === 'p89') {
      const adjustment = latestAdjustment(series, dates);
      if (adjustment) {
        delta = adjustment.delta;
        date = adjustment.date;
      }
    } else if (region?.lastAdjust) {
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
 * 把上游原始行转成页面能用的快照（与 CI 的契约一致，但只取展示所需字段）。
 * 实时补齐没有历史累积，因此只包含上游给出的窗口。
 */
export function buildLiveSnapshot(rows) {
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const gradeFields = { p92: 'n92', p95: 'n95', p98: 'n98', p0: 'n0', p89: 'n89' };
  const clean = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  };
  const regions = {};
  for (const row of rows) {
    if (!row?.regionName) continue;
    if (!regions[row.regionName]) {
      regions[row.regionName] = { regionId: row.regionId, p92: [], p95: [], p98: [], p0: [], p89: [] };
    }
    const index = dates.indexOf(row.date);
    for (const [grade, field] of Object.entries(gradeFields)) {
      regions[row.regionName][grade][index] = clean(row[field]);
    }
  }

  const byName = {};
  for (const [name, region] of Object.entries(regions)) {
    byName[name] = {
      regionId: region.regionId,
      ...Object.fromEntries(Object.entries(gradeFields).map(([grade]) => [grade, region[grade]])),
      lastAdjust: null,
    };
  }

  // 全国参考均价：各省算术平均，缺值省份不参与
  const national = {};
  for (const grade of Object.keys(gradeFields)) {
    national[grade] = dates.map((_, index) => {
      let sum = 0;
      let count = 0;
      for (const region of Object.values(byName)) {
        const value = region[grade][index];
        if (value === null) continue;
        sum += value;
        count += 1;
      }
      return count ? Math.round((sum / count + Number.EPSILON) * 100) / 100 : null;
    });
  }
  national.lastAdjust = null;

  return {
    meta: { generatedAt: new Date().toISOString(), schemaVersion: 2, nextWindow: null, crude: null },
    dates,
    national,
    regions: byName,
    crudeDaily: { brent: [] },
  };
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

  /** 上游主表直连：只在快照过期或用户主动刷新时使用。 */
  async function fetchLiveTable() {
    const response = await fetch(UPSTREAM_TABLE, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`上游返回 ${response.status}`);
    const payload = await response.json();
    if (payload?.returnCode !== 0 || !Array.isArray(payload.data)) throw new Error('上游数据格式异常');
    return payload.data;
  }


  async function refreshLive({ force = false } = {}) {
    if (!force && snapshot && !deriveView(snapshot, state, new Date()).stale) return;
    setMeta('正在拉取最新数据…');
    try {
      const rows = await fetchLiveTable();
      const live = buildLiveSnapshot(rows);
      const existing = snapshot;
      // 用实时数据替换价格序列，其余字段沿用快照（实时表没有历史累积，也就没有旧历史）
      snapshot = {
        ...existing,
        meta: { ...existing.meta, generatedAt: live.meta.generatedAt },
        dates: live.dates,
        national: live.national,
        regions: live.regions,
        crudeDaily: live.crudeDaily,
      };
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
    try {
      const response = await fetch(UPSTREAM_NEAR_TIME, { headers: { Accept: 'application/json' } });
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (rows[1]) {
        extra.nextWindow = {
          date: rows[1].date,
          gasolineChange: rows[1].gasolineChange ?? null,
          dieselChange: rows[1].dieselChange ?? null,
        };
      }
    } catch {
      /* 用快照里的值 */
    }
    try {
      const response = await fetch(UPSTREAM_CRUDE);
      const buffer = await response.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      const pick = (symbol) => {
        const match = text.match(new RegExp(`v_${symbol}="([^"]*)"`));
        if (!match) return null;
        const fields = match[1].split(',');
        return { price: Number(fields[0]), change: Number(fields[1]) };
      };
      const wti = pick('hf_CL');
      const brent = pick('hf_OIL');
      if (wti && brent) {
        extra.crude = {
          wti: wti.price,
          brent: brent.price,
          wtiChange: wti.change,
          brentChange: brent.change,
          time: '',
        };
      }
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
      const region = String(info.region ?? '');
      const match = Object.keys(snapshot?.regions ?? {}).find((name) => name.includes(region) || region.includes(name.replace(/省|市|自治区|壮族|回族|维吾尔|特别行政区/g, '')));
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
