#!/usr/bin/env node
/**
 * 设计 token 对比度校验（Aurora Glass 版）：
 * 文本/非文本配对必须达到 WCAG 要求；玻璃卡按混合后的等效实色计算。
 * 用法：node tools/check-contrast.mjs
 */

const TOKENS = {
  light: {
    bg: '#eef3fb',
    surface: '#ffffff',
    glass: '#ffffff', // 亮色模式玻璃卡用实底白（等效）
    fg: '#17203a',
    fgMuted: '#46516b',
    outline: '#7a86a2',
    outlineSoft: '#c9d2e4',
    primary: '#1e63c4',
    onPrimary: '#ffffff',
    primaryContainer: '#d9e8ff',
    onPrimaryContainer: '#0a2f66',
    up: '#b3231d',
    upContainer: '#fbeae9',
    onUpContainer: '#8c1d18',
    down: '#0e6e44',
    downContainer: '#e2f4ea',
    onDownContainer: '#0b5636',
    flatContainer: '#e9eef6',
    onFlatContainer: '#46516b',
    gradeP92: '#1e63c4',
    gradeP92Lite: '#2f86dc',
    gradeP95: '#9a5b00',
    gradeP95Lite: '#b97a1f',
    gradeP98: '#6a50d8',
    gradeP98Lite: '#8268e8',
    gradeP0: '#00727a',
    gradeP0Lite: '#0a97a0',
    gradeP89: '#a23b6b',
    gradeP89Lite: '#bf5986',
  },
  dark: {
    bg: '#0a0e1a',
    glass: '#182234', // rgba(255,255,255,.07) 混在 #0a0e1a 上的等效实色
    fg: '#e6eaf2',
    fgMuted: '#a8b0c0',
    outline: '#8b93a8',
    outlineSoft: '#2a3346',
    primary: '#6cb2ff',
    onPrimary: '#062347',
    primaryContainer: '#1e3a5f',
    onPrimaryContainer: '#cfe4ff',
    up: '#ff8a80',
    upContainer: '#4a1d1a',
    onUpContainer: '#ffd9d5',
    down: '#74dcae',
    downContainer: '#0e3d28',
    onDownContainer: '#a9ebcb',
    flatContainer: '#242e40',
    onFlatContainer: '#a8b0c0',
    gradeP92: '#5ea0f5',
    gradeP92Lite: '#8cc2ff',
    gradeP95: '#e8a65a',
    gradeP95Lite: '#f5c584',
    gradeP98: '#a78bfa',
    gradeP98Lite: '#c4afff',
    gradeP0: '#4fc3d1',
    gradeP0Lite: '#82dde6',
    gradeP89: '#e87fb0',
    gradeP89Lite: '#f2a5c8',
  },
};

/** 相对亮度 */
function luminance(hex) {
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255);
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** [说明, 前景键, 背景键, 最低要求] */
const TEXT_PAIRS = [
  ['正文 / glass', 'fg', 'glass', 4.5],
  ['正文 / bg', 'fg', 'bg', 4.5],
  ['次要文本 / glass', 'fgMuted', 'glass', 4.5],
  ['次要文本 / bg', 'fgMuted', 'bg', 4.5],
  ['主色文本 / glass', 'primary', 'glass', 4.5],
  ['选中分段文本 / onPrimary', 'onPrimary', 'primary', 4.5],
  ['选中 chip 文本', 'onPrimaryContainer', 'primaryContainer', 4.5],
  ['涨(up) / glass', 'up', 'glass', 4.5],
  ['涨(up) / upContainer', 'onUpContainer', 'upContainer', 4.5],
  ['跌(down) / glass', 'down', 'glass', 4.5],
  ['跌(down) / downContainer', 'onDownContainer', 'downContainer', 4.5],
  ['持平 / flatContainer', 'onFlatContainer', 'flatContainer', 4.5],
];

/** 价格大字是渐变文字：两端都按大文本（≥3:1）校验 */
const LARGE_PAIRS = [
  ['价格渐变深端 p92', 'gradeP92', 'surface', 3],
  ['价格渐变浅端 p92', 'gradeP92Lite', 'surface', 3],
  ['价格渐变深端 p95', 'gradeP95', 'surface', 3],
  ['价格渐变浅端 p95', 'gradeP95Lite', 'surface', 3],
  ['价格渐变深端 p98', 'gradeP98', 'surface', 3],
  ['价格渐变浅端 p98', 'gradeP98Lite', 'surface', 3],
  ['价格渐变深端 p0', 'gradeP0', 'surface', 3],
  ['价格渐变浅端 p0', 'gradeP0Lite', 'surface', 3],
  ['价格渐变深端 p89', 'gradeP89', 'surface', 3],
  ['价格渐变浅端 p89', 'gradeP89Lite', 'surface', 3],
];

/** 暗色玻璃卡上的渐变大字 */
const DARK_LARGE_PAIRS = [
  ['价格渐变深端 p92/dark', 'gradeP92', 'glass', 3],
  ['价格渐变浅端 p92/dark', 'gradeP92Lite', 'glass', 3],
  ['价格渐变深端 p95/dark', 'gradeP95', 'glass', 3],
  ['价格渐变浅端 p95/dark', 'gradeP95Lite', 'glass', 3],
  ['价格渐变深端 p98/dark', 'gradeP98', 'glass', 3],
  ['价格渐变浅端 p98/dark', 'gradeP98Lite', 'glass', 3],
  ['价格渐变深端 p0/dark', 'gradeP0', 'glass', 3],
  ['价格渐变浅端 p0/dark', 'gradeP0Lite', 'glass', 3],
  ['价格渐变深端 p89/dark', 'gradeP89', 'glass', 3],
  ['价格渐变浅端 p89/dark', 'gradeP89Lite', 'glass', 3],
];

const NON_TEXT_PAIRS = [
  ['描边 outline / glass', 'outline', 'glass', 3],
  ['图表线 p92 / glass', 'gradeP92', 'glass', 3],
  ['图表线 p95 / glass', 'gradeP95', 'glass', 3],
  ['图表线 p98 / glass', 'gradeP98', 'glass', 3],
  ['图表线 p0 / glass', 'gradeP0', 'glass', 3],
  ['图表线 p89 / glass', 'gradeP89', 'glass', 3],
  ['涨色线条 / glass', 'up', 'glass', 3],
  ['跌色线条 / glass', 'down', 'glass', 3],
];

let failures = 0;
function contrastFailures() {
  let count = 0;
  for (const [mode, token] of Object.entries(TOKENS)) {
    const pairs = [
      ...TEXT_PAIRS,
      ...(mode === 'light' ? LARGE_PAIRS : DARK_LARGE_PAIRS),
      ...NON_TEXT_PAIRS,
    ];
    for (const [, fgKey, bgKey, min] of pairs) {
      const value = ratio(token[fgKey], token[bgKey]);
      if (value < min) count += 1;
    }
  }
  return count;
}

function main() {
  for (const [mode, token] of Object.entries(TOKENS)) {
    console.log(`\n===== ${mode} =====`);
    const pairs = [
      ...TEXT_PAIRS,
      ...(mode === 'light' ? LARGE_PAIRS : DARK_LARGE_PAIRS),
      ...NON_TEXT_PAIRS,
    ];
    for (const [label, fgKey, bgKey, min] of pairs) {
      const value = ratio(token[fgKey], token[bgKey]);
      const ok = value >= min;
      if (!ok) failures += 1;
      console.log(`${ok ? '✔' : '✖'} ${label.padEnd(26)} ${token[fgKey]} on ${token[bgKey]}  ${value.toFixed(2)}:1 (需 ≥${min})`);
    }
  }
  console.log(`\n${failures === 0 ? '✅ 全部配对达标' : `❌ ${failures} 个配对不达标`}`);
  process.exit(failures === 0 ? 0 : 1);
}

export { contrastFailures, TOKENS };

const isDirectRun = process.argv[1] && process.argv[1].includes('check-contrast');
if (isDirectRun) main();
