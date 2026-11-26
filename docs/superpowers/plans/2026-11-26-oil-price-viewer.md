# 油价看板（GitHub Pages）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个托管在 GitHub Pages 的油价看板：全国均价 + 31 省可筛选，按 92/95/98/0 号展示当前价与近 1 周 / 1 月 / 1 年的阶梯价格曲线，数据由 GitHub Actions 定时抓取、页面同源读取并可实时补齐。

**Architecture:** 两条数据路径。① CI（Node 20 零依赖脚本）抓取金投网 cngold 价格表 + 腾讯原油现价 + jijinhao Brent 日 K，转成契约化 JSON 落库并随 Pages 静态发布；② 浏览器首屏只读同源 `data/oil-prices.json`（快、必成功），仅当快照超过 6 小时或用户点刷新时才直连上游做实时补齐，失败则保留快照并标注时间。图表为自绘 SVG 阶梯线，零第三方库。

**Tech Stack:** Node.js 20（`node:test` 内置测试器、`fetch`、`TextDecoder`）、原生 HTML/CSS/ESM、GitHub Actions + GitHub Pages、零运行时依赖、零 CDN。

**Spec:** `docs/superpowers/specs/2026-11-26-oil-price-viewer-design.md`（v2；本计划的每个取舍都能在 spec 的 §3 实测事实 / §6 数据契约 / §15 复核结论里找到出处）

---

## Global Constraints

以下约束对每个 task 生效，值逐字取自 spec：

- **运行时零依赖**：只用 Node 20+ 内置模块与浏览器原生 API；`package.json` 无任何 `dependencies`/`devDependencies`；页面不引用任何 CDN、外链字体、外链脚本。
- **静态站 + 无构建**：仓库根即站点根；`index.html` + `assets/` + `data/` 即全部产物；不引入打包器、预处理器、框架。
- **数据契约固定**：`data/oil-prices.json` 的 `meta / dates / national / regions / crudeDaily` 结构与 `schemaVersion: 2` 不得变更（spec §6）；省份名以 key 存储，例：`"北京市"`、`"内蒙古自治区"`。
- **哨兵归一**：`n89`/`n10`/`n20`/`n35` 的 `0` 与 `null` 一律转 `null`；`p92`/`p95`/`p98`/`p0` 值域必须在 6–13 元/升之间，否则视为脏数据（spec §6、§10、实测 C9）。
- **涨跌口径**：不存储 `*Change`；涨跌幅由相邻窗口价格相减得出（实测 C7 已验证两者逐行一致）；`lastAdjust` = **最近一次价格发生变化**的窗口，必须跳过"不调价"窗口（实测 C8：最近 47 窗口里有 8 个全 0 窗口）。
- **调价日口径**：全站统一用**生效日**（发改委公告日 = 生效日 − 1 天）。
- **每吨幅度只显示元/吨**，不做元/升折算（不引入密度假设）。
- **全国均价** = 31 省算术平均；某标号在某省为 `null` 时该省不参与该标号均价；UI 文案固定为"全国参考均价"。
- **刷新策略**：首屏只拉同源快照；仅当快照 `generatedAt` 早于 **6 小时**或用户点击「刷新」时才直连上游；实时拉取失败**保留快照**并提示，绝不白屏。
- **CI 节奏**：`schedule` cron 为 `20 */2 * * *`（UTC）；stale 阈值 6 小时；连续 3 次抓取失败才判为异常。
- **失败保护**：上游最新窗口日期早于既有快照 → 不写文件；上游窗口数 < 12 → 不写文件；数组长度与 `dates.length` 不一致 → 不写文件。
- **色彩**：涨红跌绿（中国大陆习惯）；涨跌**不得仅靠颜色**表达，必须同时带 ↑/↓ 符号与文字；数字用 `font-variant-numeric: tabular-nums`。
- **主题**：跟随 `prefers-color-scheme`，并提供手动切换，切换结果存 `localStorage`；动效遵守 `prefers-reduced-motion`。
- **移动端**：375px 宽无横向滚动、无元素重叠；触摸目标不小于 44px。
- **无障碍**：图表容器 `role="img"` + 随数据变化的 `aria-label`；所有控件键盘可达、焦点环可见；筛选用原生 `<select>`/`<button>`。
- **语言与文案**：简体中文；价格单位"元/升"；不写"最低价/最划算"等结论性推荐。
- **安全**：不把任何 token、cookie、密钥写入仓库、快照 JSON 或页面；GitHub token 只存在于本机 `~/.config/gh/`（钥匙串）。
- **仓库**：公开仓库（GitHub Pages 免费版要求）；`main` 为部署分支。

---

## Review Focus

spec 隐含但没有任务显式覆盖的输入/失效场景，按"最可能咬人"排序：

1. **上游间歇性 405 / 代理截断（实测约 490KB 处会被截断）** → 抓取必须重试并校验完整性；半个 JSON 被 `JSON.parse` 会直接抛错。
2. **"不调价"窗口价格与上一窗口完全相同** → 若直接取"最新窗口的涨跌"，页面永远显示"涨跌 0.00"。
3. **`n89` 在 7 个省是 `0` 哨兵** → 参与全国均价会把 89 号均价拉到接近 0。
4. **上游把滚动窗口左移（每次只给最近 47 个窗口）** → 若不累积合并，"近一年"视图会随时间整体左移，且历史永远只有 47 个点。
5. **快照 JSON 损坏/缺失**（CI 中断写入、Pages 发布半截文件）→ 页面必须显示错误态并可重试，不能白屏。
6. **近 1 周区间内没有任何调价点** → 图表区域不得显示成"没数据"，要有明确文案说明"本区间无调价"。
7. **用户选了没有 89 号的省** → 89 号序列全是 `null`，图表与卡片要显示 `—` 而不是 0 或 NaN。
8. **时区**：调价日按北京时间口径，快照时间戳带 `+08:00`；浏览器用 `new Date()` 解析时不得按 UTC 截断日期。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 仅 `"type": "module"` + `scripts.test`；无依赖 |
| `scripts/lib/transform.mjs` | 纯函数：行归一、历史合并、`lastAdjust`、全国均价、Brent 切片、快照组装 |
| `scripts/lib/transform.test.mjs` | 上述纯函数的单元测试 |
| `scripts/lib/upstream.mjs` | 上游抓取：重试、超时、GBK 解码、四个端点的解析 |
| `scripts/lib/upstream.test.mjs` | 抓取层测试（stub `globalThis.fetch`） |
| `scripts/fetch-oil-prices.mjs` | CLI 编排：抓取 → 校验 → 合并 → 原子写 `data/oil-prices.json` |
| `test/data-contract.test.mjs` | 快照不变量校验（31 省、长度对齐、值域、时间新鲜度） |
| `assets/logic.js` | 前端纯逻辑：区间切片、阶梯路径、格式化、空态判定、stale 判定 |
| `assets/logic.test.js` | 前端逻辑单元测试 |
| `assets/chart.js` | 图表：刻度计算 + SVG 渲染（几何计算为纯函数） |
| `assets/chart.test.js` | 图表几何单元测试 |
| `assets/app.js` | DOM 装配：加载快照、筛选联动、实时补齐、错误与提示态 |
| `assets/styles.css` | 全部样式：布局、卡片、深浅色、响应式、动效 |
| `index.html` | 页面骨架与静态文案 |
| `.github/workflows/ci.yml` | push/PR 跑 `node --test` |
| `.github/workflows/deploy.yml` | 定时抓取 → 提交数据 → 部署 Pages |
| `README.md` | 部署、数据源、口径、维护与 keepalive 说明 |
| `data/oil-prices.json` | 快照产物（入库，累积历史） |

---

## Task 1: 数据转换纯函数库

**Files:**
- Create: `package.json`
- Create: `scripts/lib/transform.mjs`
- Create: `scripts/lib/transform.test.mjs`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `GRADES: readonly string[]` = `['p92','p95','p98','p0','p89']`
  - `SOURCE_FIELDS: Record<string,string>` = `{p89:'n89', p92:'n92', p95:'n95', p98:'n98', p0:'n0'}`
  - `normalizeRows(rows: object[]): { dates: string[], regions: Record<string, { regionId: number, prices: Record<string, (number|null)> }> }`
  - `sentinelToNull(value: unknown, grade: string): number|null`
  - `mergeHistory(existing: Snapshot|null, incoming: { dates, regions }): { dates: string[], regions: Record<string, { regionId, prices }> }`
  - `computeLastAdjust(prices: (number|null)[], dates: string[]): { date: string, p92: number|null, p95: number|null, p98: number|null, p0: number|null } | null`
  - `nationalAverage(regions: Record<string, {prices}>): { p92: (number|null)[], p95: ..., p98: ..., p0: ..., p89: ... }`
  - `sliceCrude(daily: [string, number][], days?: number): [string, number][]`
  - `buildSnapshot(input): Snapshot`

- [ ] **Step 1: 写失败测试**

`scripts/lib/transform.test.mjs` 用 `node:test` + `node:assert/strict`。夹具使用真实上游形状的最小切片：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows, sentinelToNull, computeLastAdjust, nationalAverage, mergeHistory, sliceBrude } from './transform.mjs';

const ROWS = [
  { regionId: 2, regionName: '北京市', date: '2026-10-16', n89: 0,   n92: 8.61, n95: 9.17, n98: 10.67, n0: 8.36, n92Change: 0 },
  { regionId: 2, regionName: '北京市', date: '2026-10-30', n89: 0,   n92: 8.89, n95: 9.46, n98: 10.96, n0: 8.65, n92Change: 0.28 },
  { regionId: 2, regionName: '北京市', date: '2026-11-13', n89: 6.61,n92: 8.37, n95: 8.91, n98: 10.41,n0: 8.11, n92Change: -0.52 },
  { regionId: 12, regionName: '浙江省', date: '2026-10-16', n89: 6.4, n92: 8.29, n95: 8.84, n98: 10.46,n0: 8.04, n92Change: 0 },
  { regionId: 12, regionName: '浙江省', date: '2026-10-30', n89: 6.4, n92: 8.57, n95: 9.13, n98: 10.75,n0: 8.32, n92Change: 0.28 },
  { regionId: 12, regionName: '浙江省', date: '2026-11-13', n89: 6.4, n92: 8.05, n95: 8.60, n98: 10.22,n0: 7.80, n92Change: -0.52 },
];
```

断言（每条一个 test）：

- `sentinelToNull(0, 'p89')` → `null`；`sentinelToNull(6.4, 'p89')` → `6.4`；`sentinelToNull(null, 'p92')` → `null`；`sentinelToNull(8.37, 'p92')` → `8.37`；`sentinelToNull(0, 'p92')` → `null`；`sentinelToNull('abc', 'p92')` → `null`
- `normalizeRows(ROWS).dates` → `['2026-10-16','2026-10-30','2026-11-13']`（升序、去重）
- `normalizeRows(ROWS).regions['北京市'].prices.p89` → `[null, null, 6.61]`（0 哨兵转 null）
- `normalizeRows(ROWS).regions['北京市'].prices.p92` → `[8.61, 8.89, 8.37]`
- `computeLastAdjust([8.61, 8.89, 8.37], DATES)` → `{ date: '2026-11-13', p92: -0.52, ... }`
- **"不调价"用例**：`computeLastAdjust([8.61, 8.61, 8.89], DATES)` → `date: '2026-10-30'`（跳过值未变的 10-16）
- **全平用例**：`computeLastAdjust([8.61, 8.61, 8.61], DATES)` → `null`
- `computeLastAdjust([null, null, 8.37], DATES)` → `date: '2026-11-13'`，`p92: null`（首窗无前值）
- `nationalAverage({...})` 的 `p92` → `[8.45, 8.73, 8.21]`（(8.61+8.29)/2、(8.89+8.57)/2、(8.37+8.05)/2）
- `nationalAverage` 对 `p89`：北京为 `null` 不参与，只用浙江 → `[6.4, 6.4, 6.4]`
- `mergeHistory(null, incoming)` → 等于 incoming
- `mergeHistory(existing, incoming)`：`existing.dates = ['2026-01-05']`，incoming 含 `'2026-01-05'` 与 `'2026-11-13'` → 结果 `dates` 含两个日期且**升序**；`'2026-01-05'` 的值取 incoming（同日以新数据为准）
- `mergeHistory` 对**只有旧快照有**的日期：旧值被保留（累积历史不丢点）
- `mergeHistory` 后每个 region 的 `prices` 数组长度 == `dates.length`，缺失位置为 `null`
- `sliceBrude([['2026-01-01', 1], ['2026-01-02', 2]], 400)` → 原样返回；`sliceBrude` 只保留最后 N 条

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/lib/transform.test.mjs`
Expected: FAIL，报 `Cannot find module .../scripts/lib/transform.mjs`

- [ ] **Step 3: 实现 `scripts/lib/transform.mjs`**

`package.json` 写死：`{ "name": "oil-price-viewer", "private": true, "type": "module", "scripts": { "test": "node --test" } }`

实现要点（不写函数体，行为由上面的断言决定）：

- `normalizeRows`：遍历 rows，按 `date` 升序去重得到 `dates`；按 `regionName` 分组，`regionId` 取该省任一行；每个标号用 `SOURCE_FIELDS` 映射后过 `sentinelToNull`；某省在某日期无行 → 该位置 `null`。
- `sentinelToNull(value, grade)`：`p89` 及小众柴油标号下 `value <= 0` → `null`；`p92/p95/p98/p0` 下非有限数或 `<= 0` → `null`；否则返回 `Number(value)`。
- `mergeHistory(existing, incoming)`：日期取并集升序；对每个日期与每个省，优先取 incoming 的值，incoming 缺则取 existing，都缺为 `null`；返回 `{ dates, regions }`，regions 每项 `{ regionId, prices }`，`prices` 为 `{p92:[...], p95:[...], p98:[...], p0:[...], p89:[...]}`，每数组长度 == `dates.length`。
- `computeLastAdjust(prices, dates)`：从末尾向前找第一个 `prices[i] != null && prices[i-1] != null && prices[i] !== prices[i-1]` 的 i；返回 `{ date: dates[i], p92: prices[i]-prices[i-1]（保留 2 位）, p95, p98, p0 }`；找不到返回 `null`。差值用 `Math.round((a-b)*100)/100` 消除浮点误差。
- `nationalAverage(regions)`：对每个日期、每个标号，取所有省该标号非 null 值的平均；该省该标号为 null 时跳过；**一个都没有**时该点为 `null`（不是 0）。
- `sliceBrude(daily, days = 400)`：返回最后 `days` 条。
- `buildSnapshot(input)`：接收 `{ rows, nearTime, crude, crudeDaily, existing, generatedAt }`，内部串起 `normalizeRows → mergeHistory → computeLastAdjust → nationalAverage → sliceBrude`，输出：

```js
{
  meta: {
    generatedAt, schemaVersion: 2,
    sources: [ {name:'金投网 cngold 城市油价', url:'https://quote.cngold.org/oil/youjia.html'},
               {name:'金投网 jijinhao 行情', url:'https://quote.cngold.org/'},
               {name:'腾讯财经 外盘期货', url:'https://qt.gtimg.cn/q=hf_CL,hf_OIL'} ],
    lastWindow: { date },
    nextWindow: { date, gasolineChange, dieselChange },
    crude: { wti, brent, wtiChange, brentChange, time },
    notes: { priceBasis: '发改委挂牌价（生效日口径），非加油站成交价' }
  },
  dates: [...],
  national: { p92:[...], p95:[...], p98:[...], p0:[...], p89:[...], lastAdjust: {...}|null },
  regions: { [省名]: { regionId, p92:[...], ..., lastAdjust: {...}|null } },
  crudeDaily: { brent: [[day, close], ...] }
}
```

`nearTime` 形状：`{ lastWindow: { date }, nextWindow: { date, gasolineChange, dieselChange } }`（由 Task 2 产出）。
`crude` 形状：`{ wti, brent, wtiChange, brentChange, time }`。
`crudeDaily` 形状：`[[day, close], ...]`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/lib/transform.test.mjs`
Expected: PASS，全部 test 通过

- [ ] **Step 5: 提交**

```bash
git add package.json scripts/lib/transform.mjs scripts/lib/transform.test.mjs
git commit -m "feat: 数据转换纯函数库（归一/合并/最近调价/全国均价）"
```

---

## Task 2: 上游抓取层

**Files:**
- Create: `scripts/lib/upstream.mjs`
- Create: `scripts/lib/upstream.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ENDPOINTS: Record<string,string>`（`oilTable` / `nearTime` / `brentDaily` / `crudeSpot` / `ipGeo`）
  - `fetchWithRetry(url: string, opts?: { headers?: object, retries?: number, backoffMs?: number[], timeoutMs?: number, fetchImpl?: Function }): Promise<Response>`
  - `fetchJson(url: string, opts?: object): Promise<unknown>`
  - `fetchTextGbk(url: string, opts?: object): Promise<string>`
  - `fetchOilTable(): Promise<object[]>`
  - `fetchNearTime(): Promise<{ lastWindow: {date:string}, nextWindow: {date:string, gasolineChange:number|null, dieselChange:number|null} }>`
  - `fetchCrudeSpot(): Promise<{ wti:number, brent:number, wtiChange:number, brentChange:number, time:string }>`
  - `fetchBrentDaily(): Promise<[string, number][]>`

- [ ] **Step 1: 写失败测试**

stub `globalThis.fetch`（Node 20 自带 `fetch`；测试里用 `opts.fetchImpl` 注入替身，不改全局）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, fetchTextGbk, fetchOilTable, fetchNearTime, fetchCrudeSpot, fetchBrentDaily, ENDPOINTS } from './upstream.mjs';
```

断言：

- `fetchWithRetry` 第一次 405 → 第二次 200 → 返回第二个响应；调用次数 == 2
- 连续 3 次 405 → 抛错，错误消息包含 `405`
- `fetchWithRetry` 超时（`AbortError`）→ 也重试，总尝试次数 == `retries + 1`
- `fetchTextGbk` 对 GBK 字节 `Buffer.from([0xc4, 0xe3, 0xba, 0xc3])`（"布伦"）解码后为 `'布伦'`——实现里用 `new TextDecoder('gbk')`，测试断言解码结果等于 `'布伦'`
- `fetchOilTable`：注入返回 `{ returnCode: 0, data: ROWS }` 的响应 → 返回 `ROWS` 数组
- `fetchOilTable`：返回 `returnCode: 1` → 抛错
- `fetchOilTable`：解析出的 JSON 长度与 `Content-Length` 不符（模拟截断）→ 抛错并重试
- `fetchNearTime`：注入 `{ returnCode:0, data:[{date:'2026-11-13', gasolineChange:null, dieselChange:null},{date:'2026-11-27', gasolineChange:-440, dieselChange:-425}] }` → 返回 `{ lastWindow:{date:'2026-11-13'}, nextWindow:{date:'2026-11-27', gasolineChange:-440, dieselChange:-425} }`
- `fetchNearTime` 只有一行 → `nextWindow` 为 `null`
- `fetchCrudeSpot`：注入 `v_hf_CL="84.13,0.54,84.17,84.19,85.23,83.64,16:20:00,83.68,84.09,0,10,5,2026-11-26,纽约原油";\nv_hf_OIL="90.87,0.25,90.92,90.93,92.08,90.36,16:20:00,90.64,90.69,0,2,4,2026-11-26,布伦特原油";` → `{ wti: 84.13, brent: 90.87, wtiChange: 0.54, brentChange: 0.25 }`，`time` 含 `'2026-11-26'` 与 `'16:20:00'`
- `fetchBrentDaily`：注入 `var  KLC_KL = {"data":[[{"day":"2014/05/19","close":109.0},{"day":"2014/05/20","close":110.5}]]}` → `[['2014/05/19',109.0],['2014/05/20',110.5]]`（day 里的 `/` 转 `-`）
- `ENDPOINTS.oilTable` === `'https://datacenter.cngold.org/city_oil/all_price_by_year/'`
- `ENDPOINTS.nearTime` === `'https://datacenter.cngold.org/city_oil/near_time/'`
- `ENDPOINTS.brentDaily` === `'https://api.jijinhao.com/sQuoteCenter/kDataList.htm?code=JO_92272'`
- `ENDPOINTS.crudeSpot` === `'https://qt.gtimg.cn/q=hf_CL,hf_OIL'`

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/lib/upstream.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `scripts/lib/upstream.mjs`**

实现要点：

- `fetchWithRetry(url, opts)`：`retries` 默认 2（共 3 次尝试）；`backoffMs` 默认 `[1000, 3000]`；每次尝试用 `AbortSignal.timeout(timeoutMs ?? 30000)`；非 2xx 视为失败并重试；全部失败抛 `Error`，消息含最终状态码。
- 读 body 时同时拿到 `Content-Length` 与实际字节数，不一致视为截断 → 失败重试（实测代理偶发在 ~490KB 截断）。
- `fetchJson`：在 `fetchWithRetry` 基础上 `JSON.parse`（parse 失败算失败、可重试）。
- `fetchTextGbk`：`await res.arrayBuffer()` → `new TextDecoder('gbk').decode(buf)`（**不能用 `res.text()`**，它按 UTF-8 解码会乱码）。
- `fetchOilTable`：GET `ENDPOINTS.oilTable`，带 `Accept: application/json`；断言 `returnCode === 0` 且 `data` 是数组且长度 ≥ 12，否则抛错。
- `fetchNearTime`：GET `ENDPOINTS.nearTime`；`data[0]` → `lastWindow`；`data[1]` → `nextWindow`（不存在则 `null`）。
- `fetchCrudeSpot`：GET `ENDPOINTS.crudeSpot` → GBK 文本 → 正则取 `v_hf_CL="..."` 与 `v_hf_OIL="..."` → 逗号切分；下标 0=最新价、1=涨跌幅%、6=时间、12=日期；`time` = `${下标12} ${下标6}`；名称硬编码 `hf_CL→纽约原油`、`hf_OIL→布伦特原油`（不依赖 GBK 解码出的中文名）。
- `fetchBrentDaily`：GET `ENDPOINTS.brentDaily`（带 `Referer: https://quote.cngold.org/`）→ 取 `var  KLC_KL = ` 之后的 JSON → `data[0]` 为日 K 数组 → 映射为 `[[day.replaceAll('/','-'), close], ...]`。
- 所有函数接受可选 `fetchImpl` 注入，便于测试。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/lib/upstream.test.mjs`
Expected: PASS

- [ ] **Step 5: 联网冒烟（人工）**

```bash
node -e "import('./scripts/lib/upstream.mjs').then(async m => {
  const t = await m.fetchOilTable(); console.log('rows', t.length, 'provinces', new Set(t.map(r=>r.regionName)).size);
  console.log(await m.fetchNearTime());
  console.log(await m.fetchCrudeSpot());
  console.log('brent days', (await m.fetchBrentDaily()).length);
})"
```
Expected: `rows 1457 provinces 31`；`nextWindow.date` 为 `2026-11-27`；`crude.wti` ≈ 84；`brent days` ≥ 3000。网络不可达时本步跳过（不影响 Task 2 的单测结论）。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/upstream.mjs scripts/lib/upstream.test.mjs
git commit -m "feat: 上游抓取层（重试/GBK 解码/四个端点解析）"
```

---

## Task 3: 抓取 CLI 与首次播种

**Files:**
- Create: `scripts/fetch-oil-prices.mjs`

**Interfaces:**
- Consumes: Task 1 的 `buildSnapshot`；Task 2 的 `fetchOilTable` / `fetchNearTime` / `fetchCrudeSpot` / `fetchBrentDaily`
- Produces: 命令行行为 —— `node scripts/fetch-oil-prices.mjs [--dry-run] [--out <path>]`；默认写 `data/oil-prices.json`

- [ ] **Step 1: 写失败测试**

新建 `scripts/lib/cli.test.mjs`，用临时目录跑真实脚本（`--dry-run` 不写文件，不依赖网络）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../fetch-oil-prices.mjs', import.meta.url).pathname;

test('--help 退出码 0 并说明用法', () => {
  const out = execFileSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(out, /--dry-run/);
  assert.match(out, /--out/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/lib/cli.test.mjs`
Expected: FAIL（脚本不存在，node 抛 MODULE_NOT_FOUND）

- [ ] **Step 3: 实现 `scripts/fetch-oil-prices.mjs`**

要点：

- 参数解析：`--dry-run`（结果打到 stdout，不写盘）、`--out <path>`（默认 `data/oil-prices.json`）、`--help`。
- 流程：`Promise.all` 并行抓 4 个上游（其中 `nearTime` 与 `crudeSpot` 失败**不致命**：写 `null` 并在日志里标注；`oilTable` 失败**致命**：非 0 退出码）。
- 读取既有快照（存在则解析，不存在则 `null`）。
- `buildSnapshot({ rows, nearTime, crude, crudeDaily, existing, generatedAt: new Date().toISOString() })`。
- **失败保护**（命中任一 → 不写文件，退出码 1）：
  1. `snapshot.dates.length < 12`
  2. 既有快照存在且 `existing.meta.lastWindow.date > snapshot.meta.lastWindow.date`（上游回退）
  3. 任一 region 的数组长度 != `snapshot.dates.length`
- **原子写**：写 `<out>.tmp` 再 `fs.renameSync` 到 `<out>`；先 `fs.mkdirSync(path.dirname(out), { recursive: true })`。
- 日志：`console.log` 打印 `rows / dates / latest / output path`，便于 Actions 日志排查。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/lib/cli.test.mjs`
Expected: PASS

- [ ] **Step 5: 首次播种快照（联网）**

```bash
node scripts/fetch-oil-prices.mjs
node -e "const s=require('fs').readFileSync('data/oil-prices.json','utf8');const j=JSON.parse(s);console.log(j.dates.length,j.dates.at(-1),Object.keys(j.regions).length,JSON.stringify(j.meta.nextWindow))"
```
Expected: `47 2026-11-13 31 {"date":"2026-11-27","gasolineChange":-440,"dieselChange":-425}`

- [ ] **Step 6: 提交**

```bash
git add scripts/fetch-oil-prices.mjs scripts/lib/cli.test.mjs data/oil-prices.json
git commit -m "feat: 抓取 CLI 与首次快照播种"
```

---

## Task 4: 快照数据契约测试

**Files:**
- Create: `test/data-contract.test.mjs`

**Interfaces:**
- Consumes: `data/oil-prices.json`
- Produces: 无（只提供保障）

- [ ] **Step 1: 写测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync(new URL('../data/oil-prices.json', import.meta.url), 'utf8'));
```

断言：

- `snap.meta.schemaVersion === 2`
- `Object.keys(snap.regions).length === 31`
- 每个 region 的 `p92/p95/p98/p0/p89` 数组长度 === `snap.dates.length`
- `snap.dates` 严格升序且无重复
- 所有非 null 价格满足 `6 <= v <= 13`
- **无哨兵残留**：所有 `p89` 值要么是 `null` 要么 `> 0`（不得为 0）
- `snap.national.p92` 长度 === `snap.dates.length`
- 最新窗口日期在 60 天内（相对 `new Date()`；若超过则测试失败并提示需重跑抓取脚本）
- `snap.meta.nextWindow.date` 存在且形如 `YYYY-MM-DD`

- [ ] **Step 2: 跑测试确认通过**

Run: `node --test test/data-contract.test.mjs`
Expected: PASS（快照由 Task 3 播种）

- [ ] **Step 3: 提交**

```bash
git add test/data-contract.test.mjs
git commit -m "test: 快照数据契约不变量"
```

---

## Task 5: 页面骨架与样式

**Files:**
- Create: `index.html`
- Create: `assets/styles.css`

**Interfaces:**
- Consumes: 无
- Produces: DOM 契约（供 Task 6/7/8 装配使用）——
  - `#app`（根容器）
  - `#region-select`（`<select>`，省份）
  - `#locate-btn`（按钮，「定位我的省份」）
  - `#grade-chips`（标号多选容器，内部 `<button data-grade="p92">` 等）
  - `#range-tabs`（区间切换容器，内部 `<button data-range="week|month|year">`）
  - `#price-cards`（当前价卡片容器）
  - `#chart`（`<svg>`）
  - `#chart-empty`（空态文案容器）
  - `#meta-bar`（数据时间/来源/提示条）
  - `#refresh-btn`（刷新按钮）
  - `#next-window` / `#crude-card`（辅助信息容器）
  - `#theme-toggle`（主题切换）
  - `.visually-hidden`（工具类，供 aria-live 区域使用）

- [ ] **Step 1: 写 index.html 骨架**

静态文案与结构必须包含：顶栏标题「油价看板」、`#meta-bar`（默认文案"正在加载数据…"）、价格卡片区（4 张：92#汽油 / 95#汽油 / 98#汽油 / 0#柴油）、筛选区（省份 select 的第一个 option 为 `全国参考均价`；标号 chips 默认 `p92` 选中；区间 tabs 默认 `month`）、`<svg id="chart" role="img" aria-label="油价曲线">`、`#chart-empty`（默认 `hidden`）、辅助卡片区（`#next-window`、`#crude-card`）、页脚（数据源与口径说明 + 免责声明「本站价格来自公开数据源的发改委挂牌价，非加油站实际成交价，仅供参考」）。

脚本引用：`<script type="module" src="./assets/app.js"></script>`；样式：`<link rel="stylesheet" href="./assets/styles.css">`。

- [ ] **Step 2: 写 styles.css**

要求：

- CSS 变量定义浅色与深色两套主题值，`[data-theme="dark"]` 覆盖；默认 `:root` 为浅色，`@media (prefers-color-scheme: dark)` 且 `:root:not([data-theme="light"])` 时应用深色。
- 强调色 `--accent`、涨 `--up`（红）、跌 `--down`（绿）、文本 `--fg`、次要文本 `--fg-muted`、卡片背景 `--card`、页面背景 `--bg`、描边 `--border`。
- 布局：移动优先单列；`@media (min-width: 720px)` 改为双列（价格卡片 2×2），`min-width: 1080px` 时价格卡片 4×1。
- 价格数字使用 `font-variant-numeric: tabular-nums`，字号 `clamp(1.75rem, 6vw, 2.5rem)`。
- 卡片圆角 14px、`box-shadow` 轻量、`border: 1px solid var(--border)`。
- 筛选控件：chips 为 `min-height: 44px` 的 `<button>`，选中态用 `--accent` 描边 + 底色；`focus-visible` 有可见焦点环（`outline: 2px solid var(--accent); outline-offset: 2px`）。
- `@media (prefers-reduced-motion: reduce)` 下关闭所有 `transition`/`animation`。
- 375px 宽度下不得出现横向滚动：容器统一 `max-width: 100%`，长文本 `overflow-wrap: anywhere`。
- `.visually-hidden` 用 clip 方式隐藏但保留给读屏。

- [ ] **Step 3: 本地起服务肉眼验证**

```bash
python3 -m http.server 8899 --directory . &
open http://localhost:8899/index.html
```
Expected: 顶栏、空骨架卡片、chips/tabs 正常显示，无横向滚动条；深浅色切换按钮可见。

- [ ] **Step 4: 提交**

```bash
git add index.html assets/styles.css
git commit -m "feat: 页面骨架与主题样式"
```

---

## Task 6: 前端纯逻辑与状态派生

**Files:**
- Create: `assets/logic.js`
- Create: `assets/logic.test.js`

**Interfaces:**
- Consumes: 快照 JSON（结构见 spec §6）
- Produces:
  - `RANGES: { week: 7, month: 30, year: 365 }`
  - `selectRange(dates: string[], rangeKey: string, now: Date): { startIdx: number, endIdx: number }`
  - `sliceSeries(dates: string[], prices: (number|null)[], startIdx: number, endIdx: number): [string, number|null][]`
  - `buildStepPath(points: [string, number|null][], x: (d: string)=>number, y: (v: number)=>number): string`
  - `currentPrice(prices: (number|null)[]): number|null`
  - `latestAdjustment(prices: (number|null)[], dates: string[]): { date: string, delta: number } | null`
  - `formatPrice(v: number|null): string`（`null` → `'—'`）
  - `formatDelta(v: number|null): string`（正 → `'↑0.52'`，负 → `'↓0.52'`，0 → `'持平'`，null → `'—'`）
  - `deltaClass(v: number|null): 'up' | 'down' | 'flat'`
  - `isStale(generatedAt: string, now: Date, hours?: number): boolean`
  - `hasAdjustmentInRange(dates: string[], prices: (number|null)[], startIdx: number, endIdx: number): boolean`
  - `parseDateOnly(s: string): Date`（按北京时间口径解析 `YYYY-MM-DD`，返回当天 00:00 +08:00 对应的 Date，避免 UTC 截断）

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRange, sliceSeries, buildStepPath, currentPrice, latestAdjustment, formatPrice, formatDelta, deltaClass, isStale, hasAdjustmentInRange, parseDateOnly } from './logic.js';
```

断言：

- `parseDateOnly('2026-11-13')` 的 UTC 时刻为 `2026-11-12T16:00:00Z`（即北京时间 11-13 00:00），**不是** `2026-11-13T00:00:00Z`
- `selectRange(['2026-11-01','2026-11-07','2026-11-13','2026-11-20'], 'week', new Date('2026-11-26T04:00:00Z'))` → 起点落在 `2026-11-13` 之后（`startIdx >= 2`）
- `selectRange(..., 'month', ...)` → 起点落在 30 天窗口内
- `selectRange(..., 'year', ...)` → `startIdx === 0`（数据不足一年时取全部）
- `sliceSeries` 长度 == `endIdx - startIdx + 1`，首末元素与源数组一致
- `buildStepPath` 对 `[['2026-01-01', 8.0], ['2026-01-11', 8.5]]` 且 `x`/`y` 为 `(d)=>Number(d.slice(-2))`、`(v)=>v`：结果以 `'M'` 开头，含 `'L'`，且**段数为 3**（移动 + 两段水平/垂直），即阶梯而非直线插值
- `buildStepPath` 对含 `null` 值的点：跳过 null，不产生 `NaN` 字样
- `currentPrice([8.37, null])` → `null`；`currentPrice([8.37, 8.61])` → `8.61`
- `latestAdjustment([8.61, 8.61, 8.89], ['2026-10-16','2026-10-30','2026-11-13'])` → `{ date: '2026-10-30', delta: 0.28 }`
- `latestAdjustment([8.61, 8.61, 8.61], [...])` → `null`
- `formatPrice(null)` → `'—'`；`formatPrice(8.37)` → `'8.37'`
- `formatDelta(0.52)` → 含 `'↑'`；`formatDelta(-0.52)` → 含 `'↓'`；`formatDelta(0)` → `'持平'`；`formatDelta(null)` → `'—'`
- `deltaClass(0.52)` → `'up'`；`deltaClass(-0.52)` → `'down'`；`deltaClass(0)` → `'flat'`
- `isStale('2026-11-26T08:20:11+08:00', new Date('2026-11-26T15:00:00+08:00'))` → `false`
- `isStale('2026-11-26T02:00:00+08:00', new Date('2026-11-26T15:00:00+08:00'))` → `true`（超过 6 小时）
- `hasAdjustmentInRange` 对全平序列 → `false`；有变化 → `true`

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test assets/logic.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `assets/logic.js`**

要点：

- 模块必须是**纯 ESM、无 DOM 依赖**（node 与浏览器都能 import）。
- `parseDateOnly(s)`：`new Date(s + 'T00:00:00+08:00')`。
- `selectRange`：以 `now` 为基准减去 `RANGES[rangeKey]` 天，得 `cutoff`；`startIdx` = 第一个 `parseDateOnly(d) >= cutoff` 的下标（无则 0）；`endIdx` = `dates.length - 1`。
- `buildStepPath`：对每个有效点输出 `M x0 y0`，随后每个点先水平到 `x_i`（保持上一 y）再垂直到 `y_i`；`null` 点跳过且不连线到下一个点之前需断开（实现为遇到 null 时开启新 `M` 段）。
- `isStale(generatedAt, now, hours = 6)`：`now - new Date(generatedAt) > hours * 3600_000`。
- `hasAdjustmentInRange`：区间内存在相邻两点值不同且都非 null → `true`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test assets/logic.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add assets/logic.js assets/logic.test.js
git commit -m "feat: 前端纯逻辑（区间切片/阶梯路径/格式化/stale 判定）"
```

---

## Task 7: SVG 图表

**Files:**
- Create: `assets/chart.js`
- Create: `assets/chart.test.js`

**Interfaces:**
- Consumes: Task 6 的 `buildStepPath` / `parseDateOnly`
- Produces:
  - `niceTicks(min: number, max: number, count?: number): number[]`（含 min 与 max，步长为 1/2/2.5/5×10ⁿ）
  - `buildScales(input): { x: (d:string)=>number, y: (v:number)=>number, x2?: (d:string)=>number, y2?: (v:number)=>number, ticks: number[], ticks2?: number[], width: number, height: number }`
  - `renderChart(svg: SVGElement, opts: { points: [string, number|null][], overlay?: [string, number][], width: number, height: number }): void`
  - `renderOverlay(svg, overlay)` 复用同一几何；overlay 走右轴、低饱和描边

- [ ] **Step 1: 写失败测试**

断言：

- `niceTicks(8.0, 8.6, 4)` → 首尾为 `8.0` 与 `8.6`，长度 ≤ 6，步长为 0.1/0.2/0.25/0.5 之一
- `niceTicks(5, 5)`（全平）→ 返回 `[5]`（不产生除零）
- `buildScales`：给定 `points` 与 `width/height`，返回的 `x(date)` 单调递增，`y(8.37)` 在 `height` 内且 `y` 随值增大而减小
- `buildScales` 传入 `overlay` → 返回 `x2`/`y2`/`ticks2`
- `renderChart` 在没有 DOM 时**不抛错**（用 `typeof document === 'undefined'` 守卫；测试只断言函数存在且可安全调用）——真正的渲染在浏览器里验证

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test assets/chart.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 `assets/chart.js`**

要点：

- `niceTicks`：`raw = (max - min) / (count - 1)` → 取 1/2/2.5/5×10ⁿ 的合适倍数 → 生成从 floor(min/step)*step 到 ceil(max/step)*step 的刻度数组；`min === max` 时返回 `[min]`。
- `buildScales`：`pad = { top: 16, right: 44, bottom: 28, left: 44 }`；y 轴按 `niceTicks` 留 8% 余量；overlay 使用右轴（`x2`/`y2`）。
- `renderChart`：清空 svg（`svg.replaceChildren()`），按顺序追加：网格线 + y 刻度文本、y 轴标题「元/升」、阶梯路径（`stroke-width: 2`，`fill: none`，`stroke-linejoin: round`）、调价点圆点（`r: 3`）、x 轴刻度（按点数自适应抽稀，1 年视图最多 6 个标签）、overlay 路径（`stroke-opacity: 0.5`，`stroke-dasharray: none`，`stroke-width: 1.5`）、右轴刻度（右轴有 overlay 时才显示，标题「美元/桶」）。
- 颜色：通过 CSS 变量读取（`getComputedStyle(document.documentElement).getPropertyValue('--accent')`），读不到时用回退常量 `#3b82f6`。
- `renderChart` 必须能被 `ResizeObserver` 驱动重复调用（每次重算几何并重绘）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test assets/chart.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add assets/chart.js assets/chart.test.js
git commit -m "feat: SVG 阶梯线图表与右轴原油叠加"
```

---

## Task 8: 页面装配、实时补齐与容错

**Files:**
- Create: `assets/app.js`
- Modify: `index.html`（补充 `aria-live` 区域与图表 tooltip 容器）

**Interfaces:**
- Consumes: Task 5 的 DOM id 契约；Task 6 的 `logic.js`；Task 7 的 `chart.js`；快照 `data/oil-prices.json`
- Produces: 无（终态页面）

- [ ] **Step 1: 写失败测试**

新增 `assets/app.test.js`，用极简 DOM 替身（不引入 jsdom）测试**纯状态机**：把 `assets/app.js` 中的状态推导抽成可测函数。

为可测性，`assets/app.js` 必须导出以下纯函数（浏览器里不依赖它们被调用）：

- `deriveView(snapshot, state): { regionKey, regionName, grades, rangeKey, cards: { p92: {price, delta, date}, ... }, points, overlay, emptyMessage, stale, metaText }`
  - `state = { regionKey: string, grades: string[], rangeKey: 'week'|'month'|'year', overlay: boolean }`
  - `cards` 里每档：`price`（当前价）、`delta`（最近一次调价幅度，`null` 表示无）、`date`（最近调价日）
  - `points` = 所选标号在该区间的序列；`overlay` = 该区间的 Brent 日线
  - `emptyMessage`：`'本区间无调价，当前价自 2026-11-13 起未变'`（当区间内无调价点且有数据）或 `'所选区间暂无数据'`
  - `stale` = `isStale(snapshot.meta.generatedAt, now)`

断言：

- `deriveView` 用全国均价 + p92 + month 时，`cards.p92.price` 等于快照 `national.p92` 最后一项，`cards.p92.delta` 等于 `national.lastAdjust.p92`
- 切到 `'北京市'` 后 `cards.p92.price` 变成该省最后一项
- `grades` 选 `['p92','p95']` 时 `points` 含两条序列（结构：`{ grade, values }` 数组）
- 选 89 号但该省 `p89` 全为 `null` → `cards.p89.price === null`，`emptyMessage` 提示该省无 89 号
- 区间 `'week'` 且该区间无调价 → `emptyMessage` 含 `'本区间无调价'`
- `stale` 由快照时间与传入 `now` 决定

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test assets/app.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 `assets/app.js`**

要点：

- 顶部 `import { ... } from './logic.js'` 与 `import { renderChart } from './chart.js'`。
- 加载：先 `fetch('./data/oil-prices.json', { cache: 'no-cache' })`；失败 → `#meta-bar` 显示错误文案 + 显示「重试」按钮，**不白屏**。
- 状态：`{ regionKey: 'national', grades: ['p92'], rangeKey: 'month', overlay: true }`；省份选项从 `Object.keys(snapshot.regions)` 生成（`全国参考均价` 在最前）。
- 渲染：每次状态变化调用 `deriveView` → 更新价格卡片（数字、涨跌徽标、最近调价日）、`renderChart`、空态文案、`#meta-bar`（`数据更新于 {generatedAt}` + 数据源角标）。
- **图表交互**：`pointermove`/`touchmove` → 十字线 + tooltip（显示日期与该日期各标号价格）；`pointerleave` 隐藏；`click` 图例切换标号显隐。
- **实时补齐**：页面加载后 `setTimeout(3000)` 检查 `deriveView(...).stale` 或用户点 `#refresh-btn` → `fetch('https://datacenter.cngold.org/city_oil/all_price_by_year/')`（带 `Accept: application/json`）→ 成功则本地复用 `logic.js` 之外的最小归一逻辑（仅取所需 5 个标号与日期并集）热替换并重绘，`#meta-bar` 显示"已更新到最新"；失败 → 保留原数据并提示"数据源暂不可用，当前显示 {generatedAt} 前的快照"。
  - 实时补齐的请求只在"快照过期或用户点刷新"时发出（Global Constraints），首屏不得发出。
- **下次调价窗口**：`fetch('https://datacenter.cngold.org/city_oil/near_time/')` → 失败则用快照里的 `meta.nextWindow`；成功则用新值。显示文案：`下次调价 {date} · 汽油 {gasolineChange} 元/吨 · 柴油 {dieselChange} 元/吨`（负数即下调，文案用"下调"）。
- **原油现价**：`fetch('https://qt.gtimg.cn/q=hf_CL,hf_OIL')` → `arrayBuffer()` + `TextDecoder('gbk')` → 解析 `v_hf_CL` / `v_hf_OIL`；失败则用快照 `meta.crude`。
- **定位省份**：点 `#locate-btn` → `fetch('https://ipinfo.io/json')` → 用 `region` 字段匹配省份名（含"省"/"市"后缀容错）→ 命中则切换 `regionKey` 并提示；未命中提示"未识别到省份，请手动选择"。
- **主题切换**：`#theme-toggle` → 在 `light`/`dark` 间切换并写 `localStorage['oil-theme']`；初始化时读取，缺失则跟随系统。
- 所有 `fetch` 失败都被捕获，不产生未捕获 Promise 拒绝（用 `try/catch` 包裹每个请求）。
- `index.html` 补一个 `aria-live="polite"` 的 `.visually-hidden` 状态播报区，用于筛选/刷新结果播报。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test assets/app.test.js`
Expected: PASS

- [ ] **Step 5: 浏览器端到端验证**

```bash
python3 -m http.server 8899 --directory . &
open http://localhost:8899/index.html
```
逐项确认（375px 视口）：
1. 首屏 ≤2s 出现 4 张价格卡片与曲线；
2. 切省份 → 数字与曲线变化；切标号 → 多线；切区间 → X 轴变化；
3. 1 周视图显示"本区间无调价"文案；
4. 深浅色切换生效并记忆；
5. 断网（DevTools offline）后刷新 → 显示错误态 + 重试按钮，**不白屏**；
6. 无横向滚动条。

- [ ] **Step 6: 提交**

```bash
git add assets/app.js assets/app.test.js index.html
git commit -m "feat: 页面装配、实时补齐与容错"
```

---

## Task 9: CI 工作流

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: Task 3 的脚本；Task 4 的契约测试
- Produces: 两个 workflow

- [ ] **Step 1: 写 `ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm test
```

- [ ] **Step 2: 写 `deploy.yml`**

要点：

```yaml
name: Update Data & Deploy
on:
  schedule:
    - cron: '20 */2 * * *'
  workflow_dispatch:
  push:
    branches: [main]
permissions:
  contents: write
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node scripts/fetch-oil-prices.mjs
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data
          if git diff --cached --quiet; then
            echo "no data change"
          else
            git commit -m "chore(data): update oil prices"
            git push
          fi
  deploy:
    needs: update
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
        with: { ref: main }
      - uses: actions/configure-pages@v5
        with: { enablement: true }
      - uses: actions/upload-pages-artifact@v3
        with: { path: . }
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 3: 本地校验 workflow 语法**

```bash
node -e "const fs=require('fs');for(const f of ['.github/workflows/ci.yml','.github/workflows/deploy.yml']){const s=fs.readFileSync(f,'utf8');if(!s.includes('runs-on'))throw new Error(f);console.log(f,'ok')}"
```
Expected: 两行 `ok`

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "ci: 数据定时抓取与 Pages 部署工作流"
```

---

## Task 10: 部署到 GitHub Pages 并做线上冒烟

**Files:**
- 无代码改动（仅远端配置）；必要时修 `data/oil-prices.json`

**Interfaces:**
- Consumes: Task 9 的 workflow；本机已登录的 `gh`（账号 `zuoshiyue`）
- Produces: 线上站点 `https://zuoshiyue.github.io/oil-price-viewer/`

- [ ] **Step 1: 建远端仓库并推送**

```bash
cd /Users/lpf/Documents/默认项目/oil-price-viewer
git checkout -b main
git add -A
git commit -m "feat: 油价看板首版（数据管道 + 静态站 + CI）"
gh repo create oil-price-viewer --public --source=. --remote=origin --push
```
Expected: 远端 `https://github.com/zuoshiyue/oil-price-viewer`，推送成功。

- [ ] **Step 2: 开启 Pages**

```bash
gh api -X POST repos/zuoshiyue/oil-price-viewer/pages -f source[branch]=main -f source[path]=/ 2>&1 | head -20
gh api repos/zuoshiyue/oil-price-viewer/pages --jq '{url,status,build_type,source}'
```
Expected: `url` = `https://zuoshiyue.github.io/oil-price-viewer/`；`status` = `built`（首次可能需要等 1-3 分钟，或由 `deploy.yml` 的 `configure-pages` 自动完成）。

- [ ] **Step 3: 触发首次部署**

```bash
gh workflow run deploy.yml --repo zuoshiyue/oil-price-viewer
gh run list --repo zuoshiyue/oil-price-viewer --limit 3
```
Expected: 出现名为 `Update Data & Deploy` 的 run 且结论为 `success`。

- [ ] **Step 4: 线上冒烟**

```bash
curl -s -o /dev/null -w "index:%{http_code}\n" https://zuoshiyue.github.io/oil-price-viewer/
curl -s -o /dev/null -w "json:%{http_code}\n" https://zuoshiyue.github.io/oil-price-viewer/data/oil-prices.json
curl -s https://zuoshiyue.github.io/oil-price-viewer/data/oil-prices.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('dates',j.dates.length,'provinces',Object.keys(j.regions).length,'latest',j.dates.at(-1))})"
```
Expected: `index:200`、`json:200`、`dates 47 provinces 31 latest 2026-11-13`

- [ ] **Step 5: 线上页面肉眼验证**

浏览器打开 `https://zuoshiyue.github.io/oil-price-viewer/`，确认：价格卡片有数值、曲线渲染、省份可切换、1 周视图有空态文案、深浅色正常。

- [ ] **Step 6: 记录部署信息**

把最终 URL 与部署要点写进 `README.md`（Task 11）。

---

## Task 11: README 与运维说明

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 文档

- [ ] **Step 1: 写 README**

必须包含：

- 一句话简介 + 线上地址 `https://zuoshiyue.github.io/oil-price-viewer/`
- **数据源与口径**：主源金投网 cngold 城市油价（端点 URL 原文）、辅助源腾讯外盘（原油现价）、jijinhao（Brent 日 K）；"发改委挂牌价、生效日口径、非加油站成交价"；"全国参考均价 = 31 省算术平均"；"每吨幅度不折算元/升"；"不调价窗口会被跳过"四条口径各写一行。
- **本地开发**：`npm test`；`python3 -m http.server 8899 --directory .`
- **数据更新**：手动 `node scripts/fetch-oil-prices.mjs`；定时 `20 */2 * * *`；失败保护说明（不写文件、保旧快照）。
- **部署**：GitHub Pages 由 `deploy.yml` 完成；首次开启 Pages 的命令（`gh api -X POST repos/.../pages ...`）。
- **CN 访问提示**：`*.github.io` 在国内可能访问偏慢。
- **schedule 停摆兜底**：公开仓库 60 天无活动会停用定时任务；页面会自动尝试实时补齐；可选本地 keepalive：`gh workflow run deploy.yml --repo zuoshiyue/oil-price-viewer`（可放本机 cron/launchd 每周一次）。
- **目录结构**简表。

- [ ] **Step 2: 提交并推送**

```bash
git add README.md
git commit -m "docs: 部署、数据口径与运维说明"
git push
```

- [ ] **Step 3: 最终回归**

```bash
npm test
git status --porcelain   # 期望为空
```
Expected: 全部测试通过，工作区干净。

---

## 自检记录（写完计划后对照 spec 逐条核对）

- **spec 覆盖**：§3 约束 → Global Constraints + Task 1/2；§4 方案对比 → Task 3/8 的双路径实现；§5 架构 → Task 3/8/9；§6 数据契约 → Task 1 `buildSnapshot` + Task 4 契约测试；§7 抓取脚本 → Task 2/3；§8 CI → Task 9；§9 前端 → Task 5/6/7/8；§10 口径 → Global Constraints + Task 1 `lastAdjust` + Task 6 格式化；§11 未决 → Task 10（public 仓库）与 Task 11（CN 提示）；§12 测试 → Task 1/2/4/5/8；§13 验收 → Task 8 Step 5、Task 10 Step 4/5；§14 交付物 → 文件结构表。
- **Review Focus 落点**：#1 截断/405 → Task 2 重试与长度校验；#2 不调价窗口 → Task 1 `computeLastAdjust` + Task 6 `latestAdjustment`；#3 n89 哨兵 → Task 1 `sentinelToNull` + Task 1 全国均价断言 + Task 4 契约；#4 滚动窗口左移 → Task 1 `mergeHistory` + Task 3 累积；#5 快照损坏 → Task 8 错误态；#6 一周无调价 → Task 6 `hasAdjustmentInRange` + Task 8 `emptyMessage`；#7 选到无 89 号的省 → Task 8 `deriveView` 断言；#8 时区 → Task 6 `parseDateOnly` 断言。
- **类型一致性**：`buildSnapshot` 输出键名与 Task 1 断言、Task 4 契约、Task 6/8 读取键名一致（`meta/dates/national/regions/crudeDaily`，`p92/p95/p98/p0/p89`）。
