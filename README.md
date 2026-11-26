# 油价看板

一个托管在 GitHub Pages 的静态油价查看器：全国 31 省 92 / 95 / 98 / 0 号汽油的**当前挂牌价**与**近一周 / 一月 / 一年的调价走势**，可按省份、标号、时间区间筛选，移动端友好。

**线上地址**：<https://zuoshiyue.github.io/oil-price-viewer/>

## 功能

- 当前油价卡片：各标号大数字 + 最近一次调价幅度（涨红跌绿，带 ↑/↓）
- 走势曲线：**阶梯线**——国内零售价只在调价日跳变，调价之间保持不变，直线插值会造出不存在的中间价
- 筛选：省份（全国参考均价 + 31 省）、标号（可多选，89 号默认隐藏）、时间区间（周 / 月 / 年）
- 叠加 Brent 国际原油日线（右轴），提供区间内的日内波动视角
- 下次调价窗口（日期 + 每吨幅度）、WTI / Brent 现价（浏览器实时拉取）
- 深浅色主题跟随系统，可手动切换并记忆

## 数据源与口径

| 项 | 说明 |
| --- | --- |
| 主价格源 | [金投网 cngold 城市油价](https://quote.cngold.org/oil/youjia.html)（`datacenter.cngold.org/city_oil/all_price_by_year/`），31 省 × 全部调价窗口 |
| 辅助源 | [腾讯财经外盘](https://qt.gtimg.cn/q=hf_CL,hf_OIL)（原油现价）、[金投网行情](https://quote.cngold.org/)（Brent 日 K） |
| 价格口径 | 发改委挂牌价，**生效日**口径（公告日 = 生效日 − 1 天），非加油站实际成交价 |
| 全国参考均价 | 31 省算术平均，某省某标号无值时不参与该标号均价 |
| 每吨幅度 | 只显示上游给出的元/吨，不做元/升折算（折算需要密度假设） |
| 89 号汽油 | 仅部分省份有（乙醇汽油区），无值省份显示 `—` |
| 不调价窗口 | 发改委"不作调整"的窗口数据源也写一行且涨跌为 0；"最近调价"一律取**最近一次价格实际变化**的窗口 |

## 数据更新机制

- **GitHub Actions 每 2 小时**（cron `20 */2 * * *`，UTC）抓取上游 → 校验 → 合并历史 → 提交 `data/oil-prices.json` → 自动部署 Pages
- 快照在仓库里**累积合并**：上游只滚动保留最近约一年的窗口，历史窗口在仓库里不丢
- **失败保护**：上游回退、窗口数异常、数组长度不齐 → 不写文件、保留旧快照、Action 失败便于告警
- 浏览器首屏只读**同源快照**（约 60 KB）；仅当快照超过 6 小时或点击「刷新」时才直连上游做实时补齐，失败则保留快照并提示——**不会白屏**

## 本地开发

```bash
npm test                                # 全部单元与契约测试（零依赖，node --test）
python3 -m http.server 8899 --directory .   # 本地预览 http://localhost:8899/
node scripts/fetch-oil-prices.mjs       # 手动抓一次数据（--dry-run 只看不写）
```

## 部署

首次部署（已完成）：

```bash
gh repo create oil-price-viewer --public --source=. --remote=origin --push
gh api -X POST repos/zuoshiyue/oil-price-viewer/pages -f source[branch]=main -f source[path]=/
```

之后由 `.github/workflows/deploy.yml` 全自动：定时抓数据 → 有变化就提交 → 部署 Pages。

## 维护须知

- **CN 访问**：`*.github.io` 在国内访问可能偏慢，属 GitHub Pages 固有限制
- **schedule 停摆**：公开仓库 60 天无活动会静默停用定时任务；页面有浏览器实时补齐可自愈，但建议每周手动触发一次保活：
  ```bash
  gh workflow run deploy.yml --repo zuoshiyue/oil-price-viewer
  ```
- 仓库无任何密钥；抓取脚本只用 Node 20 内置模块，零第三方依赖

## 目录结构

```
.github/workflows/   ci.yml（测试）+ deploy.yml（抓取/提交/部署）
scripts/             抓取 CLI 与纯函数库（含单测）
assets/              前端：logic.js / chart.js / app.js / styles.css（含单测）
data/                快照产物（入库，累积历史）
test/                快照数据契约测试
docs/superpowers/    设计文档与实施计划
```
