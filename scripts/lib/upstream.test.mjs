import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDPOINTS,
  fetchWithRetry,
  fetchTextGbk,
  fetchOilTable,
  fetchNearTime,
  fetchCrudeSpot,
  fetchBrentDaily,
} from './upstream.mjs';

const GBK_BULEN = Buffer.from([0xb2, 0xbc, 0xc2, 0xd7]); // "布伦" 的 GBK 字节

function jsonResponse(body, init = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

test('ENDPOINTS 指向实测可用的四个上游端点', () => {
  assert.equal(ENDPOINTS.oilTable, 'https://datacenter.cngold.org/city_oil/all_price_by_year/');
  assert.equal(ENDPOINTS.nearTime, 'https://datacenter.cngold.org/city_oil/near_time/');
  assert.equal(ENDPOINTS.brentDaily, 'https://api.jijinhao.com/sQuoteCenter/kDataList.htm?code=JO_92272');
  assert.equal(ENDPOINTS.crudeSpot, 'https://qt.gtimg.cn/q=hf_CL,hf_OIL');
});

test('fetchWithRetry: 首次 405 后重试成功', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? new Response('nope', { status: 405 }) : jsonResponse({ ok: true });
  };
  const res = await fetchWithRetry('https://example.test/x', { fetchImpl, backoffMs: [1, 1] });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('fetchWithRetry: 连续失败时抛错且错误信息含状态码', async () => {
  const fetchImpl = async () => new Response('nope', { status: 405 });
  await assert.rejects(
    () => fetchWithRetry('https://example.test/x', { fetchImpl, backoffMs: [1, 1] }),
    /405/,
  );
});

test('fetchWithRetry: 超时也计入重试次数', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new DOMException('timeout', 'TimeoutError');
  };
  await assert.rejects(() => fetchWithRetry('https://example.test/x', { fetchImpl, retries: 2, backoffMs: [1, 1] }));
  assert.equal(calls, 3);
});

test('fetchWithRetry: 实际长度与 Content-Length 不符视为截断并重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{"data":[1]}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
    });
  };
  await assert.rejects(() => fetchWithRetry('https://example.test/x', { fetchImpl, backoffMs: [1, 1] }));
  assert.equal(calls, 3);
});

test('fetchTextGbk: 用 GBK 解码而不是 UTF-8', async () => {
  const fetchImpl = async () => new Response(GBK_BULEN, { status: 200 });
  const text = await fetchTextGbk('https://example.test/gbk', { fetchImpl });
  assert.equal(text, '布伦');
});

test('fetchOilTable: 返回上游 data 数组', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    regionId: 2,
    regionName: '北京市',
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    n92: 8.37,
  }));
  const fetchImpl = async () => jsonResponse({ returnCode: 0, data: rows });
  const result = await fetchOilTable({ fetchImpl });
  assert.deepEqual(result, rows);
});

test('fetchOilTable: returnCode 非 0 时抛错', async () => {
  const fetchImpl = async () => jsonResponse({ returnCode: 1, message: 'error' });
  await assert.rejects(() => fetchOilTable({ fetchImpl }), /returnCode/);
});

test('fetchOilTable: 行数不足 12 视为历史断裂并抛错', async () => {
  const fetchImpl = async () => jsonResponse({ returnCode: 0, data: [{ regionId: 2 }] });
  await assert.rejects(() => fetchOilTable({ fetchImpl }), /12/);
});

test('fetchNearTime: 解析上次与下次调价窗口', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      returnCode: 0,
      data: [
        { date: '2026-11-13', gasolineChange: null, dieselChange: null },
        { date: '2026-11-27', gasolineChange: -440, dieselChange: -425 },
      ],
    });
  const result = await fetchNearTime({ fetchImpl });
  assert.deepEqual(result, {
    lastWindow: { date: '2026-11-13' },
    nextWindow: { date: '2026-11-27', gasolineChange: -440, dieselChange: -425 },
  });
});

test('fetchNearTime: 只有一行时 nextWindow 为 null', async () => {
  const fetchImpl = async () => jsonResponse({ returnCode: 0, data: [{ date: '2026-11-13' }] });
  const result = await fetchNearTime({ fetchImpl });
  assert.equal(result.nextWindow, null);
  assert.equal(result.lastWindow.date, '2026-11-13');
});

test('fetchCrudeSpot: 解析 WTI 与 Brent 现价', async () => {
  const body =
    'v_hf_CL="84.13,0.54,84.17,84.19,85.23,83.64,16:20:00,83.68,84.09,0,10,5,2026-11-26,纽约原油";\n' +
    'v_hf_OIL="90.87,0.25,90.92,90.93,92.08,90.36,16:20:00,90.64,90.69,0,2,4,2026-11-26,布伦特原油";\n';
  const fetchImpl = async () => new Response(body, { status: 200 });
  const result = await fetchCrudeSpot({ fetchImpl });
  assert.equal(result.wti, 84.13);
  assert.equal(result.brent, 90.87);
  assert.equal(result.wtiChange, 0.54);
  assert.equal(result.brentChange, 0.25);
  assert.match(result.time, /2026-11-26/);
  assert.match(result.time, /16:20:00/);
});

test('fetchCrudeSpot: 缺少某个品种时抛错', async () => {
  const fetchImpl = async () => new Response('v_hf_CL="84.13,0.54,84.17,84.19,85.23,83.64,16:20:00,83.68,84.09,0,10,5,2026-11-26,x";', { status: 200 });
  await assert.rejects(() => fetchCrudeSpot({ fetchImpl }), /hf_OIL/);
});

test('fetchBrentDaily: 解析日 K 并把日期规范成 YYYY-MM-DD', async () => {
  const body = 'var  KLC_KL = {"data":[[{"day":"2014/05/19","close":109.0},{"day":"2014/05/20","close":110.5}]]}';
  const fetchImpl = async () => new Response(body, { status: 200 });
  const result = await fetchBrentDaily({ fetchImpl });
  assert.deepEqual(result, [['2014-05-19', 109.0], ['2014-05-20', 110.5]]);
});

test('fetchBrentDaily: 响应格式异常时抛错', async () => {
  const fetchImpl = async () => new Response('not json', { status: 200 });
  await assert.rejects(() => fetchBrentDaily({ fetchImpl }));
});
