# my-stock — 내 관심종목 현재가 + AI 분석

폰에서 열면 한국투자증권 Open API로 관심종목 현재가를 보여주고, [AI 분석]으로 3줄 요약을 받습니다.
종목을 누르면 **60분봉·일봉 볼린저밴드(20, 2σ) 차트**와 **AI 질문 창**이 열려, 스윙 관점 매수·매도 타이밍을 바로 물어볼 수 있습니다.

- `index.html` : 화면 (GitHub Pages)
- `worker.js` : 중계 서버 (Cloudflare Worker). 키는 여기 없고 Cloudflare Secret에만 있음
- 조회 전용. 주문·잔고 API 없음

## 설치 순서 (폰 브라우저로 가능)

### 1. GitHub에 올리기
저장소 `my-stock` → **Add file → Upload files** → `index.html`, `worker.js`, `README.md` 업로드 → Commit

### 2. GitHub Pages 켜기
Settings → Pages → Source: **Deploy from a branch**, Branch: **main / (root)** → Save
1~2분 뒤 주소: `https://heartwindmill.github.io/my-stock/`

### 3. Cloudflare Worker 만들기
1. dash.cloudflare.com → **Workers & Pages → Create → Worker** (Hello World로 생성), 이름 `my-stock`
2. **Edit code** → 기존 코드 전부 지우고 `worker.js` 내용 붙여넣기 → **Deploy**
3. Worker 주소 메모: `https://my-stock.<내아이디>.workers.dev`

### 4. 토큰 저장소(KV) 연결
1. **Storage & Databases → KV → Create** 이름 `my-stock-token`
2. Worker `my-stock` → **Settings → Bindings → Add → KV namespace**
   Variable name: `TOKEN_KV`, 방금 만든 KV 선택 → Deploy

### 5. 키 입력 (Settings → Variables and Secrets)
| 이름 | 종류 | 값 |
|---|---|---|
| `KIS_ENV` | Text | `mock` (테스트) → 나중에 `real` |
| `KIS_APP_KEY` | **Secret** | 모의투자 APP KEY |
| `KIS_APP_SECRET` | **Secret** | 모의투자 APP SECRET |
| `ACCESS_PIN` | **Secret** | 내가 정한 숫자 6자리 |
| `RELAY_URL` | **Secret** | Apps Script 중계 웹앱 주소 (아래 5-1) |
| `RELAY_SECRET` | **Secret** | 중계 공유 비밀값 (Apps Script와 같은 값) |
| `GEMINI_API_KEY` | **Secret** | 선택. `RELAY_URL`이 없을 때만 Gemini 직접 호출에 사용 |

키는 채팅창·메모·GitHub에 넣지 말고 여기에만 직접 입력.

### 5-1. AI 중계(Apps Script) 만들기
Worker가 홍콩 등에서 실행되면 Gemini가 `User location is not supported`로 막습니다. Google 서버(Apps Script)가 대신 호출하게 합니다.
1. script.google.com → **새 프로젝트** → 이름 `gemini-relay`
2. `Code.gs` 내용을 지우고 저장소의 `apps-script/gemini-relay.gs` 내용 붙여넣기 → 저장
3. 왼쪽 ⚙️ **프로젝트 설정 → 스크립트 속성 → 속성 추가**
   - `GEMINI_API_KEY` = 제미나이 키
   - `RELAY_SECRET` = 긴 무작위 문자열 (30자 이상 권장, 영문·숫자)
4. 오른쪽 위 **배포 → 새 배포** → 유형 ⚙️ **웹 앱**
   - 실행 사용자: **나**, 액세스 권한: **모든 사용자** → 배포 → 권한 승인
5. 나온 **웹 앱 URL**(`https://script.google.com/macros/s/…/exec`)을 Worker Secret `RELAY_URL`에, 같은 비밀값을 `RELAY_SECRET`에 입력 → Deploy
6. 브라우저로 웹 앱 URL을 열어 `{"ok":true}`가 보이면 배포 정상
- `gemini-relay.gs`를 고친 뒤에는 **배포 → 배포 관리 → ✏️ → 버전: 새 버전 → 배포** (주소 유지)
- AI 오류 메시지 끝의 `[중계 · colo XXX]`는 Worker가 실행된 지역 코드입니다 (원인 추적용)

### 6. 폰에서 사용
1. `https://heartwindmill.github.io/my-stock/` 접속
2. ⚙️ 설정에 Worker 주소와 PIN 입력 → 저장
3. 크롬 메뉴 → **홈 화면에 추가**

### 종목 상세 화면 (볼린저밴드 + AI 질문)
- 목록에서 종목을 누르면 열립니다. ⟳ 버튼으로 차트를 다시 불러옵니다.
- 60분봉: 최근 7거래일(약 49개 봉), 일봉: 최근 약 100거래일. 둘 다 BB(20, 2σ) 상·중·하단 표시
- 차트 아래 칩: 밴드 안 위치(%B), 밴드 수축·확장, 중심선 방향, 최근 상·하단 터치
- 매수가·손절가·익절가를 설정에 넣어두면 차트에 점선으로 표시
- **📋 판단 재료**: Worker가 미리 계산한 숫자(기준 시각·장 상태, 일봉·60분봉 BB, 20일·전일 고저, 돌파했던 선 시험 여부, 지지·저항 2개씩, 헤드룸, 평균 일중 변동폭, 손절 폭·주말 경고). AI는 이 숫자만 인용합니다.
- **📝 내 계획·이벤트 메모**: 종목별로 이 폰에만 저장. "계획·이벤트 함께 보내기"(기본 켜짐)일 때 AI에 전달되고, 메모 속 가격·날짜("1,150~1,180", "115만", "11/24")는 자동으로 뽑아 그대로 인용하게 합니다. 매수가·수량은 메모에 적지 마세요.
- AI 질문: 빠른 질문 버튼(종합 판단·매수·매도·손절·스퀴즈) 또는 직접 입력. 답은 **결론 → 화면 확인 → 판단 근거(표) → 종가 조건별 다음 계획 → 반대 근거 → 고지** 순서.
  - 답을 받은 뒤 코드가 형식·가격 숫자(판단 재료와 ±0.5%)·금지 표현을 검사하고, 문제 있으면 1회만 다시 요청합니다(질문당 최대 2회 호출). 그래도 남으면 답 위에 ⚠ 경고.
  - 답 아래에 "모델 · 재요청 n회 · 기준시각", **🔎 보낸 데이터 보기**에서 실제 전송한 전문을 확인할 수 있습니다.
  - "내 매수가 함께 보내기"를 켤 때만 매수가·손절가·익절가(수량 없음)가 AI로 전달됩니다.
- **60분봉은 실전 키(`KIS_ENV=real`)에서만 7거래일치가 나옵니다.** 모의투자 서버는 지난 날짜 분봉을 주지 않아 오늘 것만 나옵니다.
- 처음 여는 종목은 분봉을 모으느라 10초 안팎 걸립니다. 지난 날짜 60분봉은 KV에 저장돼 다음부터 빠릅니다.

### 코드 고친 뒤 반영
- `index.html` → GitHub에 push하면 1~2분 뒤 반영
- `worker.js` → Cloudflare Worker **Edit code**에 다시 붙여넣고 **Deploy** (GitHub push만으로는 반영 안 됨)

### 실전 시세로 바꾸기
`KIS_ENV`를 `real`로, `KIS_APP_KEY`/`KIS_APP_SECRET`을 실전 키로 교체 → Deploy

## 자주 나는 오류
| 화면 메시지 | 해결 |
|---|---|
| PIN이 맞지 않습니다 | 설정의 PIN과 ACCESS_PIN이 같은지 |
| 허용되지 않은 접속입니다 | github.io 페이지에서 열었는지 (worker 주소를 직접 열면 이 메시지가 정상) |
| 토큰 발급 실패 | KIS_ENV(mock/real)와 키 종류가 맞는지 |
| EGW00201 | 초당 호출 한도. 잠시 후 새로고침 (모의 서버에서 잦음) |
| Failed to fetch / 연결 오류 | Worker가 KIS 서버 포트(9443/29443)에 못 붙는 경우일 수 있음. Settings → Compatibility date를 최신으로 |

참고용 정보이며 투자 판단과 책임은 본인에게 있습니다.
