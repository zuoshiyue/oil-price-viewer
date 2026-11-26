import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastFailures } from '../tools/check-contrast.mjs';

test('设计 token 的全部文本/非文本配对达到 WCAG 对比度', () => {
  const failures = contrastFailures();
  assert.equal(failures, 0, `有 ${failures} 个颜色配对对比度不足，跑 node tools/check-contrast.mjs 看明细`);
});
