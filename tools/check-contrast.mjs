#!/usr/bin/env node
/**
 * M3 token 对比度校验：所有文本/非文本配对必须达到 WCAG 要求。
 * 用法：node tools/check-contrast.mjs
 */

const TOKENS = {
  light: {
    bg: '#F3F5F9',
    surface: '#FFFFFF',
    surface2: '#E9EEF6',
    surface3: '#DCE4EF',
    fg: '#1A1C1E',
    fgMuted: '#43474E',
    outline: '#74777F',
    outlineSoft: '#C4C7CE',
    primary: '#1F5AA8',
    onPrimary: '#FFFFFF',
    primaryContainer: '#D6E3FF',
    onPrimaryContainer: '#0A2F66',
    up: '#B3231D',
    upContainer: '#FBEAE9',
    onUpContainer: '#8C1D18',
    down: '#0E6E44',
    downContainer: '#E2F4EA',
    onDownContainer: '#0B5636',
    flat: '#43474E',
    flatContainer: '#E9EEF6',
    onFlatContainer: '#43474E',
  },
  dark: {
    bg: '#111318',
    surface: '#1A1C21',
    surface2: '#23262C',
    surface3: '#2C3038',
    fg: '#E3E2E6',
    fgMuted: '#C4C6CC',
    outline: '#8E9099',
    outlineSoft: '#3C4048',
    primary: '#A8C7F0',
    onPrimary: '#0A2F66',
    primaryContainer: '#274A78',
    onPrimaryContainer: '#D6E3FF',
    up: '#FFB4AB',
    upContainer: '#5C1F1B',
    onUpContainer: '#FFD9D5',
    down: '#74DCAE',
    downContainer: '#14452F',
    onDownContainer: '#C4F1DD',
    flat: '#C4C6CC',
    flatContainer: '#2C3038',
    onFlatContainer: '#C4C6CC',
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

/** [说明, 前景, 背景, 最低要求] */
const TEXT_PAIRS = [
  ['正文 / surface', 'fg', 'surface', 4.5],
  ['正文 / bg', 'fg', 'bg', 4.5],
  ['次要文本 / surface', 'fgMuted', 'surface', 4.5],
  ['次要文本 / surface2', 'fgMuted', 'surface2', 4.5],
  ['次要文本 / bg', 'fgMuted', 'bg', 4.5],
  ['价格数字 / surface2', 'fg', 'surface2', 4.5],
  ['主色文本 / surface', 'primary', 'surface', 4.5],
  ['选中分段文本 / onPrimary', 'onPrimary', 'primary', 4.5],
  ['选中 chip 文本', 'onPrimaryContainer', 'primaryContainer', 4.5],
  ['涨(up) / surface', 'up', 'surface', 4.5],
  ['涨(up) / upContainer', 'onUpContainer', 'upContainer', 4.5],
  ['跌(down) / surface', 'down', 'surface', 4.5],
  ['跌(down) / downContainer', 'onDownContainer', 'downContainer', 4.5],
  ['持平 / flatContainer', 'onFlatContainer', 'flatContainer', 4.5],
];

const NON_TEXT_PAIRS = [
  ['描边 outline / surface', 'outline', 'surface', 3],
  ['图表主线 p92(primary) / surface', 'primary', 'surface', 3],
  ['涨色线条 / surface', 'up', 'surface', 3],
  ['跌色线条 / surface', 'down', 'surface', 3],
  ['深色模式 p92 线条 / surface', 'primary', 'surface', 3],
];

let failures = 0;
function contrastFailures() {
  let count = 0;
  for (const token of Object.values(TOKENS)) {
    for (const [label, fgKey, bgKey, min] of [...TEXT_PAIRS, ...NON_TEXT_PAIRS]) {
      void label;
      const value = ratio(token[fgKey], token[bgKey]);
      if (value < min) count += 1;
    }
  }
  return count;
}

function main() {
  for (const [mode, token] of Object.entries(TOKENS)) {
    console.log(`\n===== ${mode} =====`);
    for (const [label, fgKey, bgKey, min] of TEXT_PAIRS) {
      const value = ratio(token[fgKey], token[bgKey]);
      const ok = value >= min;
      if (!ok) failures += 1;
      console.log(`${ok ? '✔' : '✖'} ${label.padEnd(28)} ${token[fgKey]} on ${token[bgKey]}  ${value.toFixed(2)}:1 (需 ≥${min})`);
    }
    for (const [label, fgKey, bgKey, min] of NON_TEXT_PAIRS) {
      const value = ratio(token[fgKey], token[bgKey]);
      const ok = value >= min;
      if (!ok) failures += 1;
      console.log(`${ok ? '✔' : '✖'} ${label.padEnd(28)} ${token[fgKey]} on ${token[bgKey]}  ${value.toFixed(2)}:1 (需 ≥${min})`);
    }
  }
  console.log(`\n${failures === 0 ? '✅ 全部配对达标' : `❌ ${failures} 个配对不达标`}`);
  process.exit(failures === 0 ? 0 : 1);
}

export { contrastFailures, TOKENS };

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv[1].includes('check-contrast');
if (isDirectRun) main();
