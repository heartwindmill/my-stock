// =====================================================================
// my-stock 중계 서버 (Cloudflare Worker)
// - 한국투자증권(KIS) Open API로 국내 주식·ETF 시세(현재가·일봉·분봉)만 조회합니다.
// - 주문·잔고·계좌 API는 일부러 넣지 않았습니다.
// - 키는 코드에 없습니다. Cloudflare 대시보드의 Secret에서 읽습니다.
// - 주소: GET /price, GET /chart, GET /facts, POST /analyze, POST /ask
//
// 필요한 설정 (Settings → Variables and Secrets)
//   KIS_ENV        (Text)   mock 또는 real
//   KIS_APP_KEY    (Secret) 한국투자증권 APP KEY
//   KIS_APP_SECRET (Secret) 한국투자증권 APP SECRET
//   ACCESS_PIN     (Secret) 내가 정한 접속 PIN (예: 숫자 6자리)
//   RELAY_URL      (Secret) AI용. Apps Script 웹앱 주소 (apps-script/gemini-relay.gs)
//   RELAY_SECRET   (Secret) AI용. Apps Script 스크립트 속성 RELAY_SECRET과 같은 값
//   GEMINI_API_KEY (Secret) 선택. RELAY_URL이 없을 때만 Gemini를 직접 호출 (지역 차단될 수 있음)
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
async function loadChartData(env, code) {
  const token = await getToken(env);
  const notes = [];
  const daily = await fetchDaily(env, token, code);
  const dates = daily.bars.map((b) => b.d);
  const lastDate = dates[dates.length - 1];
  if (!lastDate) throw new Error('일봉 데이터가 없습니다');
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

  return { code, name: daily.name, price: daily.price, change: daily.change, rate: daily.rate, daily: daily.bars, h60, notes };
}

function factsOrError(data) {
  try {
    return computeFacts(data);
  } catch (e) {
    return { error: `판단 재료 계산 실패: ${String(e.message || e).slice(0, 200)}`, lines: [], json: null };
  }
}

async function handleChart(request, env, origin) {
  const code = (new URL(request.url).searchParams.get('code') || '').trim();
  if (!/^[0-9A-Z]{6,7}$/.test(code)) return json({ error: '종목코드가 올바르지 않습니다' }, 400, origin);
  const data = await loadChartData(env, code);
  return json({
    mode: isReal(env) ? 'real' : 'mock',
    at: new Date().toISOString(),
    code,
    name: data.name,
    price: data.price,
    change: data.change,
    rate: data.rate,
    daily: forChart(data.daily),
    h60: forChart(data.h60),
    notes: data.notes,
    facts: factsOrError(data),
  }, 200, origin);
}

// 판단 재료만 따로 조회 (확인·디버깅용)
async function buildFactSheet(env, code) {
  return factsOrError(await loadChartData(env, code));
}

async function handleFacts(request, env, origin) {
  const code = (new URL(request.url).searchParams.get('code') || '').trim();
  if (!/^[0-9A-Z]{6,7}$/.test(code)) return json({ error: '종목코드가 올바르지 않습니다' }, 400, origin);
  return json({ at: new Date().toISOString(), code, facts: await buildFactSheet(env, code) }, 200, origin);
}

// =====================================================================
// 판단 재료 (fact sheet) — AI가 숫자를 지어내지 않도록 코드가 미리 계산
// 입력: loadChartData 결과 (daily·h60 봉: { d, hm, o, h, l, c, v }, 오래된 순)
// 출력: { lines: [짧은 한국어 문장], json: {구조화 값} }
// =====================================================================
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const won = (n) => `${Math.round(n).toLocaleString('en-US')}원`;
const sgn = (x, digits = 1) => `${x > 0 ? '+' : ''}${x.toFixed(digits)}%`;
const md = (d) => `${+d.slice(4, 6)}/${+d.slice(6, 8)}`;
const ymdOf = (dt) => dt.toISOString().slice(0, 10).replace(/-/g, '');

function bbSeries(bars, n = 20, k = 2) {
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += bars[j].c;
    const mid = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (bars[j].c - mid) ** 2;
    const sd = Math.sqrt(v / n);
    return { mid, up: mid + k * sd, lo: mid - k * sd };
  });
}

// 마지막 봉 기준 BB 요약. slopeTh: 중심선 '횡보'로 볼 3봉 변화율 기준(%)
function bbSummary(bars, slopeTh) {
  const bb = bbSeries(bars);
  const i = bars.length - 1;
  if (i < 0 || !bb[i]) return null;
  const b = bb[i];
  const c = bars[i].c;
  const widthOf = (x) => ((x.up - x.lo) / x.mid) * 100;
  const width = widthOf(b);
  const ws = bb.slice(-20).filter(Boolean).map(widthOf);
  const avgWidth = ws.reduce((a, x) => a + x, 0) / ws.length;
  const state = width < avgWidth * 0.8 ? '수축' : width > avgWidth * 1.2 ? '확장' : '보통';
  const p3 = bb[i - 3];
  const slope3 = p3 ? (b.mid / p3.mid - 1) * 100 : 0;
  const dir = slope3 > slopeTh ? '상승' : slope3 < -slopeTh ? '하락' : '횡보';
  let upTouch = 0;
  let loTouch = 0;
  for (let j = Math.max(0, i - 9); j <= i; j++) {
    if (!bb[j]) continue;
    if (bars[j].h >= bb[j].up) upTouch++;
    if (bars[j].l <= bb[j].lo) loTouch++;
  }
  return {
    up: Math.round(b.up), mid: Math.round(b.mid), lo: Math.round(b.lo),
    pctB: Math.round(((c - b.lo) / (b.up - b.lo)) * 100),
    width: +width.toFixed(2), avgWidth: +avgWidth.toFixed(2), state,
    slope3: +slope3.toFixed(2), dir, upTouch, loTouch,
  };
}

function bbLine(title, s) {
  if (!s) return `${title}: 봉이 20개 미만이라 계산 불가`;
  return `${title}: 상단 ${won(s.up)} / 중심 ${won(s.mid)} / 하단 ${won(s.lo)} · %B ${s.pctB} · 밴드폭 ${s.width}%(20봉 평균 ${s.avgWidth}%, ${s.state}) · 중심선 3봉 ${sgn(s.slope3, 2)}(${s.dir}) · 최근 10봉 상단터치 ${s.upTouch}회, 하단터치 ${s.loTouch}회`;
}

// 기준 시각·장 상태·다음 거래일 (공휴일은 반영 못 함)
function sessionInfo(lastDate) {
  const now = kstNow();
  const dt = new Date(Date.now() + KST_MS);
  const wd = dt.getUTCDay();
  const weekday = wd >= 1 && wd <= 5;
  const tradedToday = lastDate === now.date;
  let status;
  if (!weekday) status = '휴장(주말)';
  else if (now.hms < '090000') status = '장 시작 전';
  else if (!tradedToday) status = '휴장 추정(오늘 시세 없음)';
  else status = now.hms < '153000' ? '장중' : '장 마감';

  let nd = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  if (!(weekday && status === '장 시작 전')) {
    do { nd = new Date(nd.getTime() + 86400000); } while (nd.getUTCDay() === 0 || nd.getUTCDay() === 6);
  }
  return {
    date: now.date,
    time: `${now.hms.slice(0, 2)}:${now.hms.slice(2, 4)}`,
    weekday: WEEKDAY[wd],
    status,
    live: status === '장중',
    tradedToday,
    nextTradingDay: ymdOf(nd),
    nextWeekday: WEEKDAY[nd.getUTCDay()],
    isFriday: wd === 5,
  };
}

// 일봉 스윙 고점·저점 (좌우 2봉보다 높/낮은 봉)
function swingPoints(bars, lookback) {
  const highs = [];
  const lows = [];
  const start = Math.max(2, bars.length - lookback);
  for (let i = start; i < bars.length - 2; i++) {
    const b = bars[i];
    const nb = [bars[i - 2], bars[i - 1], bars[i + 1], bars[i + 2]];
    if (nb.every((x) => b.h > x.h)) highs.push({ i, p: b.h, d: b.d });
    if (nb.every((x) => b.l < x.l)) lows.push({ i, p: b.l, d: b.d });
  }
  return { highs, lows };
}

function computeFacts(data) {
  const bars = data.daily;
  const n = bars.length;
  if (n < 2) throw new Error('일봉이 2개 미만');
  const last = bars[n - 1];
  const prev = bars[n - 2];
  const ses = sessionInfo(last.d);
  const price = data.price || last.c;
  const prevClose = data.price ? data.price - data.change : prev.c;
  const chgPct = (price / prevClose - 1) * 100;
  const dayLabel = ses.tradedToday ? '당일' : `최근 거래일(${md(last.d)})`;
  // 전일 = 마지막 봉의 직전 봉 (장 전·휴장이면 마지막 봉이 '최근 거래일')
  const refPrev = ses.tradedToday ? prev : last;
  const refPrevLabel = ses.tradedToday ? `전일(${md(prev.d)})` : `직전 거래일(${md(last.d)})`;

  const daily = bbSummary(bars, 0.1);
  const h60 = bbSummary(data.h60, 0.05);

  // 최근 20일 평균 일중 변동폭 (진행 중인 오늘 봉 제외)
  const done = ses.live ? bars.slice(0, -1) : bars;
  const rng = [];
  for (let j = Math.max(1, done.length - 20); j < done.length; j++) rng.push(((done[j].h - done[j].l) / done[j - 1].c) * 100);
  const avgRange = rng.length ? rng.reduce((a, x) => a + x, 0) / rng.length : 0;

  // 최근 20거래일 고점·저점
  const last20 = bars.slice(-20);
  const hi20 = last20.reduce((a, b) => (b.h > a.h ? b : a));
  const lo20 = last20.reduce((a, b) => (b.l < a.l ? b : a));

  // 돌파·이탈했던 선 재시험 (스윙 고·저점 기준)
  const tol = Math.max(1, avgRange * 0.5); // 현재가가 선 근처로 볼 거리(%)
  const { highs, lows } = swingPoints(bars, 60);
  const tests = [];
  for (const s of highs) {
    const k = bars.findIndex((b, j) => j > s.i && b.c > s.p);
    if (k < 0 || k >= n - 1) continue;
    const maxAfter = Math.max(...bars.slice(k).map((b) => b.h));
    if (maxAfter >= s.p * 1.02 && Math.abs(price / s.p - 1) * 100 <= tol) {
      tests.push({ kind: 'support', p: s.p, d: s.d, text: `${won(s.p)}(${md(s.d)} 고점, 돌파했던 선) 시험 중 · 현재가 ${sgn((price / s.p - 1) * 100, 1)}` });
    }
  }
  for (const s of lows) {
    const k = bars.findIndex((b, j) => j > s.i && b.c < s.p);
    if (k < 0 || k >= n - 1) continue;
    const minAfter = Math.min(...bars.slice(k).map((b) => b.l));
    if (minAfter <= s.p * 0.98 && Math.abs(price / s.p - 1) * 100 <= tol) {
      tests.push({ kind: 'resistance', p: s.p, d: s.d, text: `${won(s.p)}(${md(s.d)} 저점, 이탈했던 선) 재시험 중 · 현재가 ${sgn((price / s.p - 1) * 100, 1)}` });
    }
  }
  tests.sort((a, b) => Math.abs(price - a.p) - Math.abs(price - b.p));

  // 지지·저항 후보 (BB 선 + 고·저점), 0.3% 이내는 하나로 합침
  const cands = [];
  const add = (p, label) => { if (p > 0) cands.push({ p: Math.round(p), label }); };
  if (daily) { add(daily.up, '일봉 BB 상단'); add(daily.mid, '일봉 BB 중심'); add(daily.lo, '일봉 BB 하단'); }
  if (h60) { add(h60.up, '60분봉 BB 상단'); add(h60.mid, '60분봉 BB 중심'); add(h60.lo, '60분봉 BB 하단'); }
  add(hi20.h, `20일 고점(${md(hi20.d)})`);
  add(lo20.l, `20일 저점(${md(lo20.d)})`);
  add(refPrev.h, `${refPrevLabel} 고가`);
  add(refPrev.l, `${refPrevLabel} 저가`);
  for (const t of tests) add(t.p, `${md(t.d)} ${t.kind === 'support' ? '고점, 돌파했던 선' : '저점, 이탈했던 선'}`);
  for (const s of highs) add(s.p, `${md(s.d)} 고점`);
  for (const s of lows) add(s.p, `${md(s.d)} 저점`);
  const pick = (list) => {
    const out = [];
    for (const c of list) {
      const near = out.find((o) => Math.abs(o.p / c.p - 1) < 0.003);
      if (near) { if (!near.label.includes(c.label)) near.label += `·${c.label}`; continue; }
      if (out.length >= 2) break; // 2개 고른 뒤에도 바로 옆 가격대는 위에서 합쳐 넣음
      out.push({ ...c });
    }
    return out.map((o) => ({ ...o, dist: +((o.p / price - 1) * 100).toFixed(2) }));
  };
  // 현재가와 같은 가격(시험 중인 선)은 지지로 봄
  const resist = pick(cands.filter((c) => c.p > price).sort((a, b) => a.p - b.p));
  const support = pick(cands.filter((c) => c.p <= price).sort((a, b) => b.p - a.p));

  const headroom = resist[0] ? resist[0].dist : null;
  const supportDist = support[0] ? -support[0].dist : null;
  const narrowStop = supportDist !== null && avgRange > 0 && supportDist < avgRange / 2;

  // ---- 문장 목록 ----
  const L = [];
  L.push(`기준 시각: ${md(ses.date)}(${ses.weekday}) ${ses.time} KST · ${ses.status} · 다음 거래일 ${md(ses.nextTradingDay)}(${ses.nextWeekday}) (공휴일 미반영)`);
  L.push(`현재가 ${won(price)} · 전일 종가 ${won(prevClose)} 대비 ${sgn(chgPct, 1)}`);
  L.push(`${dayLabel} 시가 ${won(last.o)} · 고가 ${won(last.h)} · 저가 ${won(last.l)}`);
  L.push(bbLine('일봉 BB(20,2)', daily));
  if (daily) L.push(`현재가는 일봉 중심선 ${price >= daily.mid ? '위' : '아래'} (중심선까지 ${sgn((daily.mid / price - 1) * 100, 1)})`);
  L.push(bbLine('60분봉 BB(20,2)', h60));
  L.push(`최근 20거래일 고점 ${won(hi20.h)}(${md(hi20.d)}) · 저점 ${won(lo20.l)}(${md(lo20.d)})`);
  L.push(`${refPrevLabel} 고가 ${won(refPrev.h)} · 저가 ${won(refPrev.l)}`);
  for (const t of tests.slice(0, 2)) L.push(t.text);
  L.push(`위 저항: ${resist.length ? resist.map((r) => `${won(r.p)}(${r.label}, ${sgn(r.dist, 1)})`).join(' / ') : '가까운 저항 없음(신고가 구간)'}`);
  L.push(`아래 지지: ${support.length ? support.map((s) => `${won(s.p)}(${s.label}, ${sgn(s.dist, 1)})`).join(' / ') : '가까운 지지 없음'}`);
  L.push(`다음 저항까지 헤드룸 ${headroom === null ? '없음' : sgn(headroom, 1)} · 가장 가까운 지지까지 ${supportDist === null ? '없음' : `-${supportDist.toFixed(1)}%`}`);
  L.push(`최근 20일 평균 일중 변동폭 ${avgRange.toFixed(1)}%`);
  if (narrowStop) L.push(`⚠ 손절 폭이 변동성 대비 좁음: 가장 가까운 지지 ${won(support[0].p)}까지 -${supportDist.toFixed(1)}%로 평균 일중 변동폭(${avgRange.toFixed(1)}%)의 절반보다 작아, 그 바로 아래 손절은 노이즈에 걸리기 쉬움`);
  if (ses.isFriday) L.push('⚠ 금요일: 주말 보유 리스크(월요일 갭 가능)');
  if (!h60) L.push('참고: 60분봉이 20개 미만이라 60분봉 BB 없음');

  return {
    lines: L,
    json: {
      session: ses,
      price, prevClose, changePct: +chgPct.toFixed(2),
      day: { label: dayLabel, date: last.d, o: last.o, h: last.h, l: last.l },
      prevDay: { date: refPrev.d, h: refPrev.h, l: refPrev.l },
      daily, h60,
      high20: { p: hi20.h, d: hi20.d }, low20: { p: lo20.l, d: lo20.d },
      retests: tests.map(({ text, ...r }) => r),
      resistance: resist, support,
      headroomPct: headroom, supportDistPct: supportDist,
      avgRangePct: +avgRange.toFixed(2),
      flags: { narrowStop, weekendRisk: ses.isFriday },
    },
  };
}

// ---------------------------------------------------------------------
// Gemini 호출 공통
// - RELAY_URL이 있으면 Apps Script 중계로 호출 (Worker 실행 지역과 무관)
// - 없으면 예전처럼 직접 호출 (홍콩 등에서 "User location is not supported" 가능)
// - 오류 메시지에 Worker 실행 위치(colo)를 붙여 원인 추적
// ---------------------------------------------------------------------
const aiReady = (env) => Boolean((env.RELAY_URL && env.RELAY_SECRET) || env.GEMINI_API_KEY);
const AI_NOT_READY = 'AI 설정이 없습니다 (RELAY_URL·RELAY_SECRET을 설정하세요)';

async function callGemini(env, payload, colo) {
  const model = env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const viaRelay = Boolean(env.RELAY_URL && env.RELAY_SECRET);
  const where = `${viaRelay ? '중계' : '직접'} · colo ${colo || '?'}`;
  let status;
  let data;
  try {
    if (viaRelay) {
      // Apps Script는 POST 결과를 302로 googleusercontent.com에 넘겨주는데,
      // 그 주소는 GET으로만 열림. 자동 추적은 POST를 유지해 405가 나므로 직접 GET으로 따라감
      // 오류 추적용 경로 표시: 호스트 + 마지막 경로만 (배포 ID·쿼리는 숨김)
      const brief = (u) => {
        try { const x = new URL(u); return `${x.host}/…/${x.pathname.split('/').filter(Boolean).pop() || ''}`; } catch { return '주소 형식 오류'; }
      };
      const relayUrl = String(env.RELAY_URL).trim();
      let res = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: env.RELAY_SECRET, model, payload }),
        redirect: 'manual',
      });
      const trail = [`POST ${brief(relayUrl)} → ${res.status}`];
      for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
        const next = res.headers.get('location');
        if (!next) break;
        res = await fetch(next, { method: 'GET', redirect: 'manual' });
        trail.push(`GET ${brief(next)} → ${res.status}`);
      }
      const raw = await res.text();
      let r = null;
      try { r = JSON.parse(raw); } catch { /* HTML 등 */ }
      if (!r) {
        const title = (raw.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
        return { error: `AI 중계 응답 실패 [${where}] 경로: ${trail.join(' / ')}${title ? ` · 페이지 제목: ${title.slice(0, 80)}` : ''}` };
      }
      if (r.error) return { error: `AI 중계 오류 (${r.status}) [${where}] ${String(r.error).slice(0, 200)}` };
      status = r.status;
      data = r.body || {};
    } else {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
      });
      status = res.status;
      data = await res.json().catch(() => ({}));
    }
  } catch (e) {
    return { error: `AI 연결 실패 [${where}] ${String(e.message || e).slice(0, 200)}` };
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    if (status === 429) return { error: `무료 한도 초과입니다. 잠시 후 다시 시도하세요. [${where}]` };
    // Gemini가 준 오류 설명을 함께 보여줌 (키 값은 포함되지 않음)
    const why = data?.error?.message || data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || '';
    return { error: `AI 응답 실패 (${status}) [${model} · ${where}] ${String(why).slice(0, 300)}`.trim() };
  }
  return { text };
}

// ---------------------------------------------------------------------
// AI 분석 (목록 화면) — 시세 숫자만 보냄. 보유 수량·금액은 보내지 않음
// ---------------------------------------------------------------------
async function handleAnalyze(request, env, origin) {
  if (!aiReady(env)) return json({ error: AI_NOT_READY }, 400, origin);
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

  const result = await callGemini(env, { contents: [{ role: 'user', parts: [{ text: prompt }] }] }, request.cf?.colo);
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
  if (!aiReady(env)) return json({ error: AI_NOT_READY }, 400, origin);
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
  }, request.cf?.colo);
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
      if (request.method === 'GET' && pathname === '/facts') return await handleFacts(request, env, origin);
      if (request.method === 'POST' && pathname === '/analyze') return await handleAnalyze(request, env, origin);
      if (request.method === 'POST' && pathname === '/ask') return await handleAsk(request, env, origin);
      return json({ error: '없는 주소입니다' }, 404, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, origin);
    }
  },
};
