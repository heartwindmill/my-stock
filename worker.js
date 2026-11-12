// =====================================================================
// my-stock 중계 서버 (Cloudflare Worker)
// - 한국투자증권(KIS) Open API로 국내 주식·ETF "현재가"만 조회합니다.
// - 주문·잔고·계좌 API는 일부러 넣지 않았습니다.
// - 키는 코드에 없습니다. Cloudflare 대시보드의 Secret에서 읽습니다.
//
// 필요한 설정 (Settings → Variables and Secrets)
//   KIS_ENV        (Text)   mock 또는 real
//   KIS_APP_KEY    (Secret) 한국투자증권 APP KEY
//   KIS_APP_SECRET (Secret) 한국투자증권 APP SECRET
//   ACCESS_PIN     (Secret) 내가 정한 접속 PIN (예: 숫자 6자리)
//   GEMINI_API_KEY (Secret) 선택. AI 분석 버튼용
// 필요한 바인딩 (Settings → Bindings → KV namespace)
//   TOKEN_KV  : 접근토큰을 하루 동안 재사용하기 위한 저장소
// =====================================================================

const ALLOWED_ORIGIN = 'https://heartwindmill.github.io';

const KIS_BASE = {
  real: 'https://openapi.koreainvestment.com:9443',
  mock: 'https://openapivts.koreainvestment.com:29443',
};

const GEMINI_MODEL_DEFAULT = 'gemini-3.5-flash-lite';
const MAX_CODES = 15; // 한 번에 조회할 최대 종목 수

let memToken = null; // 같은 인스턴스 안에서 토큰 재사용

// ---------------------------------------------------------------------
// 공통: CORS 헤더와 JSON 응답
// ---------------------------------------------------------------------
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-pin',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// KIS 접근토큰: 발급 후 KV에 저장해 24시간 가까이 재사용
// (토큰을 자주 새로 받으면 KIS에서 제한하므로 반드시 재사용)
// ---------------------------------------------------------------------
async function getToken(env) {
  const mode = env.KIS_ENV === 'real' ? 'real' : 'mock';
  const now = Date.now();
  const kvKey = `kis_token_${mode}`;

  if (memToken && memToken.mode === mode && memToken.exp > now + 5 * 60 * 1000) {
    return memToken.token;
  }

  if (env.TOKEN_KV) {
    const saved = await env.TOKEN_KV.get(kvKey, 'json');
    if (saved && saved.exp > now + 5 * 60 * 1000) {
      memToken = saved;
      return saved.token;
    }
  }

  const res = await fetch(`${KIS_BASE[mode]}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    // 키 값은 절대 응답에 넣지 않고, KIS가 준 오류 메시지만 전달
    throw new Error(`토큰 발급 실패 (${res.status}) ${data.error_description || data.msg1 || ''}`.trim());
  }

  const ttlSec = Number(data.expires_in) || 86400;
  memToken = { mode, token: data.access_token, exp: now + ttlSec * 1000 };
  if (env.TOKEN_KV) {
    await env.TOKEN_KV.put(kvKey, JSON.stringify(memToken), {
      expirationTtl: Math.max(60, ttlSec - 600),
    });
  }
  return memToken.token;
}

// ---------------------------------------------------------------------
// 국내 주식·ETF 현재가 1건 조회 (tr_id FHKST01010100, 실전·모의 동일)
// ---------------------------------------------------------------------
async function fetchPrice(env, token, code) {
  const mode = env.KIS_ENV === 'real' ? 'real' : 'mock';
  const url = new URL(`${KIS_BASE[mode]}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', code);

  const res = await fetch(url.toString(), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (data.rt_cd !== '0' || !data.output) {
    return { code, error: `${data.msg_cd || res.status} ${data.msg1 || '조회 실패'}`.trim() };
  }
  const o = data.output;
  return {
    code,
    price: Number(o.stck_prpr),       // 현재가
    change: Number(o.prdy_vrss),      // 전일 대비
    rate: Number(o.prdy_ctrt),        // 등락률(%)
    high: Number(o.stck_hgpr),        // 고가
    low: Number(o.stck_lwpr),         // 저가
    volume: Number(o.acml_vol),       // 누적 거래량
  };
}

async function handlePrice(request, env, origin) {
  const url = new URL(request.url);
  const codes = (url.searchParams.get('codes') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9A-Z]{6,7}$/.test(s))
    .slice(0, MAX_CODES);
  if (codes.length === 0) return json({ error: '종목코드가 없습니다' }, 400, origin);

  const token = await getToken(env);
  // 모의투자 서버는 초당 호출 한도가 낮으므로 간격을 넉넉히
  const gap = env.KIS_ENV === 'real' ? 120 : 600;
  const items = [];
  for (const code of codes) {
    let item = await fetchPrice(env, token, code);
    if (item.error && /EGW00201/.test(item.error)) {
      // 초당 한도 초과 → 1초 쉬고 한 번 더
      await sleep(1000);
      item = await fetchPrice(env, token, code);
    }
    items.push(item);
    await sleep(gap);
  }
  return json({ mode: env.KIS_ENV === 'real' ? 'real' : 'mock', at: new Date().toISOString(), items }, 200, origin);
}

// ---------------------------------------------------------------------
// AI 분석 (Gemini) — 시세 숫자만 보냄. 보유 수량·금액은 보내지 않음
// ---------------------------------------------------------------------
async function handleAnalyze(request, env, origin) {
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다' }, 400, origin);
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_CODES) : [];
  if (items.length === 0) return json({ error: '분석할 시세가 없습니다' }, 400, origin);

  const lines = items
    .map((i) => `- ${String(i.name).slice(0, 40)}: 현재가 ${i.price}원, 전일대비 ${i.change}원 (${i.rate}%)`)
    .join('\n');

  const prompt = `너는 장기 연금 투자자를 돕는 시장 요약 도우미다. 아래는 오늘(${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST) 관심종목 시세다.
${lines}

다음 형식으로 한국어로 짧게 답하라.
1) 한 줄 요약
2) 상승·기본·하락 시나리오 각 1줄
3) 오늘 점검 필요 여부 (필요/불필요 + 이유 1줄)
규칙: 매수·매도 지시나 수익 보장 표현 금지. 확실하지 않은 원인(뉴스 등)은 추측하지 말고 "확인 필요"라고 쓸 것. 연금 계좌는 장기 분산 관점을 유지할 것.`;

  const model = env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const msg = res.status === 429 ? '무료 한도 초과입니다. 잠시 후 다시 시도하세요.' : `AI 응답 실패 (${res.status})`;
    return json({ error: msg }, 502, origin);
  }
  return json({ text }, 200, origin);
}

// ---------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 내 페이지에서 온 요청 + PIN 일치할 때만 처리
    if (origin !== ALLOWED_ORIGIN) return json({ error: '허용되지 않은 접속입니다' }, 403, origin);
    if (!env.ACCESS_PIN || request.headers.get('x-pin') !== env.ACCESS_PIN) {
      return json({ error: 'PIN이 맞지 않습니다' }, 401, origin);
    }
    if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
      return json({ error: 'KIS 키가 설정되지 않았습니다' }, 500, origin);
    }

    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'GET' && pathname === '/price') return await handlePrice(request, env, origin);
      if (request.method === 'POST' && pathname === '/analyze') return await handleAnalyze(request, env, origin);
      return json({ error: '없는 주소입니다' }, 404, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, origin);
    }
  },
};
