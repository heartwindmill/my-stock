# my-stock — 내 관심종목 현재가 + AI 분석

폰에서 열면 한국투자증권 Open API로 관심종목 현재가를 보여주고, [AI 분석]으로 3줄 요약을 받습니다.

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
| `GEMINI_API_KEY` | **Secret** | 제미나이 키 (AI 분석용, 선택) |

키는 채팅창·메모·GitHub에 넣지 말고 여기에만 직접 입력.

### 6. 폰에서 사용
1. `https://heartwindmill.github.io/my-stock/` 접속
2. ⚙️ 설정에 Worker 주소와 PIN 입력 → 저장
3. 크롬 메뉴 → **홈 화면에 추가**

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
