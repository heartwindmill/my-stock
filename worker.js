// =====================================================================
// my-stock 중계 서버 (Cloudflare Worker)
// - 한국투자증권(KIS) Open API로 국내 주식·ETF 시세(현재가·일봉·분봉)만 조회합니다.
// - 주문·잔고·계좌 API는 일부러 넣지 않았습니다.
// - 키는 코드에 없습니다. Cloudflare 대시보드의 Secret에서 읽습니다.
// - 주소: GET /price, GET /chart, POST /analyze, POST /ask
//
// 필요한 설정 (Settings → Variables and Secrets)
//   KIS_ENV        (Text)   mock 또는 real
//   KIS_APP_KEY    (Secret) 한국투자증권 APP KEY
//   KIS_APP_SECRET (Secret) 한국투자증권 APP SECRET
//   ACCESS_PIN     (Secret) 내가 정한 접속 PIN (예: 숫자 6자리)
//   GEMINI_API_KEY (Secret) 선택. AI 분석·AI 질문용
//   GEMINI_MODEL   (Text)   선택. 비우면 아래 GEMINI_MODEL_DEFAULT
// 필요한 바인딩 (Settings → Bindings → KV namespace)
//   TOKEN_KV  : 접근토큰 재사용 + 지난 날짜 60분봉 저장소
// =====================================================================

const ALLOWED_ORIGIN = 'https://heartwindmill.github.io';

const KIS_BASE = {
  real: 'https://openapi.koreainvestment.com:9443',
  mock: 'https://openapivts.koreainvestment.com:29443',
};

const GEMINI_MODEL_DEFAULT = 'gemini-3.5-flash-lite';
const MAX_CODES = 15; // 한 번에 조회할 최대 종목 수
const PAST_DAYS_60 = 6; // 60분봉에 쓸 과거 거래일 수 (+오늘 = 7거래일, 약 49개 봉)
const KST_MS = 9 * 3600 * 1000;

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
const pad2 = (n) => String(n).padStart(2, '0');
const isReal = (env) => env.KIS_ENV === 'real';
const callGap = (env) => (isReal(env) ? 70 : 600); // 실전 초당 20건, 모의 초당 2건 한도

// ---------------------------------------------------------------------
// KIS 접근토큰: 발급 후 KV에 저장해 24시간 가까이 재사용
// (토큰을 자주 새로 받으면 KIS에서 제한하므로 반드시 재사용)
// ---------------------------------------------------------------------
async function getToken(env) {
  const mode = isReal(env) ? 'real' : 'mock';
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
  const mode = isReal(env) ? 'real' : 'mock';
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
  const gap = isReal(env) ? 120 : 600;
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
  return json({ mode: isReal(env) ? 'real' : 'mock', at: new Date().toISOString(), items }, 200, origin);
}

// ---------------------------------------------------------------------
// 차트용 공통 도구
// ---------------------------------------------------------------------
function kstNow() {
  const iso = new Date(Date.now() + KST_MS).toISOString();
  return { date: iso.slice(0, 10).replace(/-/g, ''), hms: iso.slice(11, 19).replace(/:/g, '') };
}

function kstDateDaysAgo(days) {
  return new Date(Date.now() + KST_MS - days * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

// KST 시각을 "UTC인 척" 하는 초 단위 시간 (차트 라벨이 KST 그대로 보이게)
function toTs(date, hms) {
  return Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +hms.slice(0, 2), +hms.slice(2, 4)) / 1000;
}

function minusMinute(hms) {
  const t = +hms.slice(0, 2) * 60 + +hms.slice(2, 4) - 1;
  return pad2(Math.floor(t / 60)) + pad2(t % 60) + '00';
}

// KIS GET 호출. 초당 한도(EGW00201)면 1초 쉬고 한 번 더
async function kisGet(env, token, path, trId, params) {
  const mode = isReal(env) ? 'real' : 'mock';
  const url = new URL(KIS_BASE[mode] + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url.toString(), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: trId,
        custtype: 'P',
      },
    });
    const data = await res.json().catch(() => ({}));
    if (data.rt_cd === '0') return data;
    if (attempt === 0 && /EGW00201/.test(data.msg_cd || '')) { await sleep(1000); continue; }
    throw new Error(`${data.msg_cd || res.status} ${data.msg1 || '조회 실패'}`.trim());
  }
}

// 일봉 (FHKST03010100) — 최근 약 100거래일 + 현재가 정보
async function fetchDaily(env, token, code) {
  const data = await kisGet(env, token, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: code,
    FID_INPUT_DATE_1: kstDateDaysAgo(160),
    FID_INPUT_DATE_2: kstNow().date,
    FID_PERIOD_DIV_CODE: 'D',
    FID_ORG_ADJ_PRC: '0',
  });
  const o1 = data.output1 || {};
  const bars = (data.output2 || [])
    .filter((r) => r && r.stck_bsop_date && Number(r.stck_clpr) > 0)
    .map((r) => ({ d: r.stck_bsop_date, hm: '000000', o: +r.stck_oprc, h: +r.stck_hgpr, l: +r.stck_lwpr, c: +r.stck_clpr, v: +r.acml_vol }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  return { name: o1.hts_kor_isnm || '', price: +o1.stck_prpr, change: +o1.prdy_vrss, rate: +o1.prdy_ctrt, bars };
}

// 분봉 한 거래일치를 장 마감 쪽부터 거꾸로 페이지 단위로 모음
// fetchPage(hour) → output2 배열(최신순). date가 null이면 첫 응답의 날짜를 씀
async function collectMinutes(env, fetchPage, date, startHms, maxCalls) {
  const map = new Map();
  let hour = startHms;
  for (let calls = 0; calls < maxCalls; calls++) {
    if (calls > 0) await sleep(callGap(env));
    const rows = (await fetchPage(hour)).filter((r) => r && r.stck_cntg_hour && Number(r.stck_prpr) > 0);
    if (!date && rows.length) date = rows[0].stck_bsop_date;
    const sameDay = rows.filter((r) => r.stck_bsop_date === date);
    if (!sameDay.length) break;
    let earliest = '999999';
    for (const r of sameDay) {
      const hm = r.stck_cntg_hour;
      if (hm < earliest) earliest = hm;
      if (hm < '090000' || hm > '153000') continue;
      map.set(hm, { d: date, hm, o: +r.stck_oprc, h: +r.stck_hgpr, l: +r.stck_lwpr, c: +r.stck_prpr, v: +r.cntg_vol || 0 });
    }
    if (earliest <= '090000') break;
    const next = minusMinute(earliest);
    if (next >= hour) break;
    hour = next;
  }
  return [...map.values()].sort((a, b) => (a.hm < b.hm ? -1 : 1));
}

// 실전: 주식일별분봉조회 (FHKST03010230) — 지난 날짜 분봉 가능, 1회 최대 120건
function fetchDayMinutesReal(env, token, code, date, startHms, maxCalls = 5) {
  const page = async (hour) =>
    (await kisGet(env, token, '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice', 'FHKST03010230', {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_HOUR_1: hour,
      FID_INPUT_DATE_1: date,
      FID_PW_DATA_INCU_YN: 'Y',
      FID_FAKE_TICK_INCU_YN: '',
    })).output2 || [];
  return collectMinutes(env, page, date, startHms, maxCalls);
}

// 모의: 주식당일분봉조회 (FHKST03010200) — 당일만, 1회 30건
function fetchTodayMinutesMock(env, token, code, startHms, maxCalls = 13) {
  const page = async (hour) =>
    (await kisGet(env, token, '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
      FID_ETC_CLS_CODE: '',
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_HOUR_1: hour,
      FID_PW_DATA_INCU_YN: 'N',
    })).output2 || [];
  return collectMinutes(env, page, null, startHms, maxCalls);
}

// 1분봉 → 60분봉 (09시, 10시 … 15시 구간)
function toHourly(mins) {
  const out = [];
  let cur = null;
  for (const b of mins) {
    const hh = b.hm.slice(0, 2);
    if (!cur || cur.d !== b.d || cur.hh !== hh) {
      cur = { d: b.d, hh, hm: hh + '0000', o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return out.map(({ hh, ...r }) => r);
}

const isFullDay = (mins) => mins.length > 0 && mins[0].hm <= '091000' && mins[mins.length - 1].hm >= '152000';
const forChart = (bars) => bars.map((b) => ({ t: toTs(b.d, b.hm), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));

// ---------------------------------------------------------------------
// 상세 차트 데이터: 일봉(약 100거래일) + 60분봉(최근 7거래일, 1분봉을 모아 만듦)
// 지난 날짜의 60분봉은 바뀌지 않으므로 KV에 저장해 재사용 (호출 수 절약)
// ---------------------------------------------------------------------
async function handleChart(request, env, origin) {
  const code = (new URL(request.url).searchParams.get('code') || '').trim();
  if (!/^[0-9A-Z]{6,7}$/.test(code)) return json({ error: '종목코드가 올바르지 않습니다' }, 400, origin);

  const token = await getToken(env);
  const notes = [];
  const daily = await fetchDaily(env, token, code);
  const dates = daily.bars.map((b) => b.d);
  const lastDate = dates[dates.length - 1];
  if (!lastDate) return json({ error: '일봉 데이터가 없습니다' }, 502, origin);
  const now = kstNow();

  let m1 = [];
  const h60 = [];
  if (isReal(env)) {
    const live = lastDate === now.date && now.hms >= '090000' && now.hms < '153000';
    await sleep(callGap(env));
    m1 = await fetchDayMinutesReal(env, token, code, lastDate, live ? now.hms : '153000');

    const past = dates.slice(-1 - PAST_DAYS_60, -1);
    const cached = env.TOKEN_KV
      ? await Promise.all(past.map((d) => env.TOKEN_KV.get(`h60:${code}:${d}`, 'json').catch(() => null)))
      : past.map(() => null);
    for (let i = 0; i < past.length; i++) {
      let hourly = cached[i];
      if (!hourly) {
        try {
          await sleep(callGap(env));
          const mins = await fetchDayMinutesReal(env, token, code, past[i], '153000');
          hourly = toHourly(mins);
          if (env.TOKEN_KV && isFullDay(mins)) {
            await env.TOKEN_KV.put(`h60:${code}:${past[i]}`, JSON.stringify(hourly), { expirationTtl: 20 * 86400 });
          }
        } catch (e) {
          notes.push(`${past[i]} 분봉 조회 실패: ${e.message}`);
          hourly = [];
        }
      }
      h60.push(...hourly);
    }
    h60.push(...toHourly(m1));
  } else {
    await sleep(callGap(env));
    const live = now.hms >= '090000' && now.hms < '153000';
    m1 = await fetchTodayMinutesMock(env, token, code, live ? now.hms : '153000');
    h60.push(...toHourly(m1));
    notes.push('모의투자 서버는 지난 날짜 분봉을 주지 않아 60분봉이 오늘 것만 나옵니다. KIS_ENV를 real(실전 키)로 바꾸면 최근 7거래일 60분봉이 나옵니다.');
  }

  return json({
    mode: isReal(env) ? 'real' : 'mock',
    at: new Date().toISOString(),
    code,
    name: daily.name,
    price: daily.price,
    change: daily.change,
    rate: daily.rate,
    daily: forChart(daily.bars),
    h60: forChart(h60),
    notes,
  }, 200, origin);
}

// ---------------------------------------------------------------------
// Gemini 호출 공통
// ---------------------------------------------------------------------
async function callGemini(env, payload) {
  const model = env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    if (res.status === 429) return { error: '무료 한도 초과입니다. 잠시 후 다시 시도하세요.' };
    // Gemini가 준 오류 설명을 함께 보여줌 (키 값은 포함되지 않음)
    const why = data?.error?.message || data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || '';
    return { error: `AI 응답 실패 (${res.status}) [${model}] ${String(why).slice(0, 300)}`.trim() };
  }
  return { text };
}

// ---------------------------------------------------------------------
// AI 분석 (목록 화면) — 시세 숫자만 보냄. 보유 수량·금액은 보내지 않음
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

  const result = await callGemini(env, { contents: [{ role: 'user', parts: [{ text: prompt }] }] });
  return json(result, result.error ? 502 : 200, origin);
}

// ---------------------------------------------------------------------
// AI 질문 (상세 화면) — 스윙 관점, 볼린저밴드 기반 매수·매도 타이밍 대화
// context: 화면에서 계산한 일봉·60분봉·1분봉 시세와 밴드 값 (텍스트)
// ---------------------------------------------------------------------
const SWING_PROMPT = `너는 한국 주식·ETF 스윙 트레이딩(보유 기간 며칠~몇 주) 관점의 기술적 분석 도우미다.
사용자는 볼린저밴드(20, 2σ)를 쓰며, 일봉으로 큰 흐름과 매매 구간을, 60분봉으로 실제 진입·청산 타이밍을 잡는다.
아래 [차트 데이터]만 근거로 답하라.

기본 답변 형식 (질문이 구체적이면 그 질문에 맞춰 더 짧게):
1) 결론: 매수 관점 / 매도·익절 관점 / 관망 중 하나 + 확신도(높음·보통·낮음) + 한 줄 이유
2) 일봉: 밴드 안 위치(%B), 밴드폭 수축·확장, 중심선 기울기, 상단·하단 터치 흐름
3) 60분봉: 지금 단기 위치와 바로 쓸 수 있는 진입·청산 신호 (60분봉 밴드가 없으면 그 사실을 밝히고 일봉 위주로)
4) 가격대: 분할매수 고려 구간 / 익절 구간 / 손절 기준 — 반드시 밴드 값 등 데이터의 숫자를 근거로 제시
5) 대응 시나리오: "○○원 위로 가면 …, ○○원 아래로 가면 …" 2~3줄

규칙:
- 데이터에 없는 뉴스·실적·수급은 추측하지 말고 "확인 필요"라고 쓴다.
- 수익 보장, 단정적 표현("무조건", "확실히") 금지. 조건부로 말한다.
- 사용자의 매수가가 주어지면 그 기준 수익률과 손익 관리 관점도 포함한다.
- 한국어, 모바일에서 읽기 쉽게 짧은 줄 위주로 쓴다. 표는 쓰지 않는다.`;

async function handleAsk(request, env, origin) {
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다' }, 400, origin);
  const body = await request.json().catch(() => ({}));
  const question = String(body.question || '').trim().slice(0, 1000);
  const context = String(body.context || '').slice(0, 20000);
  if (!question) return json({ error: '질문을 입력하세요' }, 400, origin);
  if (!context) return json({ error: '차트 데이터가 없습니다' }, 400, origin);

  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-8)
    .filter((h) => h && h.text)
    .map((h) => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 4000) }] }));

  const nowKst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const result = await callGemini(env, {
    systemInstruction: { parts: [{ text: `${SWING_PROMPT}\n\n[차트 데이터] (질문 시각 ${nowKst} KST)\n${context}` }] },
    contents: [...history, { role: 'user', parts: [{ text: question }] }],
  });
  return json(result, result.error ? 502 : 200, origin);
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
      if (request.method === 'GET' && pathname === '/chart') return await handleChart(request, env, origin);
      if (request.method === 'POST' && pathname === '/analyze') return await handleAnalyze(request, env, origin);
      if (request.method === 'POST' && pathname === '/ask') return await handleAsk(request, env, origin);
      return json({ error: '없는 주소입니다' }, 404, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, origin);
    }
  },
};
