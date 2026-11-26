/**
 * 上游抓取层：金投网 cngold / jijinhao / 腾讯财经。
 *
 * 实测要点（2026-11-26）：
 * - 上游会间歇性返回 405，且公司代理偶发在 ~490KB 处截断响应 → 必须重试 + 校验长度。
 * - 腾讯行情是 GBK 编码，Response.text() 按 UTF-8 解码会乱码 → 必须走 arrayBuffer + TextDecoder('gbk')。
 * - jijinhao 日 K 需要 Referer: https://quote.cngold.org/，否则 666。
 */

export const ENDPOINTS = {
  oilTable: 'https://datacenter.cngold.org/city_oil/all_price_by_year/',
  nearTime: 'https://datacenter.cngold.org/city_oil/near_time/',
  brentDaily: 'https://api.jijinhao.com/sQuoteCenter/kDataList.htm?code=JO_92272',
  crudeSpot: 'https://qt.gtimg.cn/q=hf_CL,hf_OIL',
  ipGeo: 'https://ipinfo.io/json',
};

const DEFAULT_BACKOFF_MS = [1000, 3000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试与完整性校验的抓取。
 * 非 2xx、超时、内容长度与 Content-Length 不符都算失败并重试。
 */
export async function fetchWithRetry(
  url,
  { headers = {}, retries = 2, backoffMs = DEFAULT_BACKOFF_MS, timeoutMs = 30000, fetchImpl } = {},
) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const attempts = retries + 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let attemptError = null;
    try {
      const response = await doFetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        attemptError = new Error(`HTTP ${response.status} ${url}`);
      } else {
        const declared = response.headers.get('content-length');
        if (declared) {
          const actual = (await response.clone().arrayBuffer()).byteLength;
          if (Number(declared) !== actual) {
            attemptError = new Error(`响应被截断：声明 ${declared} 字节，实际 ${actual} 字节 ${url}`);
          }
        }
        if (!attemptError) return response;
      }
    } catch (error) {
      attemptError = error instanceof Error ? error : new Error(String(error));
    }
    lastError = attemptError;
    if (attempt < attempts - 1) {
      await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
    }
  }
  throw lastError ?? new Error(`抓取失败 ${url}`);
}

/** 抓 JSON；解析失败也算失败并重试。 */
export async function fetchJson(url, options = {}) {
  const { retries = 2, backoffMs = DEFAULT_BACKOFF_MS, ...rest } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithRetry(url, { ...rest, retries: 0, backoffMs: [0] });
      const text = await response.text();
      return JSON.parse(text);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retries) await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
    }
  }
  throw lastError ?? new Error(`JSON 抓取失败 ${url}`);
}

/** 抓 GBK 文本（腾讯行情）。 */
export async function fetchTextGbk(url, options = {}) {
  const response = await fetchWithRetry(url, { ...options, headers: { Accept: 'text/plain, */*', ...(options.headers ?? {}) } });
  const buffer = await response.arrayBuffer();
  return new TextDecoder('gbk').decode(buffer);
}

/** 全国各省 × 调价窗口的完整价格表。 */
export async function fetchOilTable(options = {}) {
  const payload = await fetchJson(ENDPOINTS.oilTable, {
    headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
    ...options,
  });
  if (!payload || payload.returnCode !== 0) {
    throw new Error(`上游 returnCode 非 0：${payload?.message ?? '未知'}`);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error('上游返回缺少 data 数组');
  }
  if (payload.data.length < 12) {
    throw new Error(`上游窗口数异常，仅 ${payload.data.length} 行（应至少 12 行）`);
  }
  return payload.data;
}

/** 上次与下次调价窗口。 */
export async function fetchNearTime(options = {}) {
  const payload = await fetchJson(ENDPOINTS.nearTime, {
    headers: { Accept: 'application/json' },
    ...options,
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (!rows.length) throw new Error('near_time 未返回窗口数据');
  const [first, second] = rows;
  return {
    lastWindow: { date: first.date },
    nextWindow: second
      ? {
          date: second.date,
          gasolineChange: second.gasolineChange ?? null,
          dieselChange: second.dieselChange ?? null,
        }
      : null,
  };
}

/** 国际原油现价（WTI / Brent）。 */
export async function fetchCrudeSpot(options = {}) {
  const text = await fetchTextGbk(ENDPOINTS.crudeSpot, options);
  const pick = (symbol) => {
    const match = text.match(new RegExp(`v_${symbol}="([^"]*)"`));
    if (!match) throw new Error(`腾讯行情缺少 ${symbol}`);
    const fields = match[1].split(',');
    return {
      price: Number(fields[0]),
      changePercent: Number(fields[1]),
      time: `${fields[12]} ${fields[6]}`,
    };
  };
  const cl = pick('hf_CL');
  const oil = pick('hf_OIL');
  return {
    wti: cl.price,
    brent: oil.price,
    wtiChange: cl.changePercent,
    brentChange: oil.changePercent,
    time: cl.time,
  };
}

/** Brent 日 K 序列（[[YYYY-MM-DD, close], ...]）。 */
export async function fetchBrentDaily(options = {}) {
  const text = await fetchWithRetry(ENDPOINTS.brentDaily, {
    headers: { Referer: 'https://quote.cngold.org/', Accept: 'application/json, text/javascript, */*' },
    ...options,
  }).then((res) => res.text());

  const match = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) throw new Error('jijinhao 日 K 响应格式异常');
  const payload = JSON.parse(match[1]);
  const series = payload?.data?.[0];
  if (!Array.isArray(series) || !series.length) throw new Error('jijinhao 日 K 数据为空');
  return series
    .filter((bar) => bar && bar.day && typeof bar.close === 'number')
    .map((bar) => [String(bar.day).replaceAll('/', '-'), bar.close]);
}
