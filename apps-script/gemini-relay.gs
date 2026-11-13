// =====================================================================
// gemini-relay (Google Apps Script 웹앱)
// Cloudflare Worker가 홍콩 등 Gemini 미지원 지역에서 실행될 때
// "User location is not supported" 오류를 피하려고 Google 서버에서 대신 호출합니다.
//
// 키는 코드에 없습니다. 프로젝트 설정 → 스크립트 속성에 넣습니다.
//   GEMINI_API_KEY : 제미나이 키
//   RELAY_SECRET   : Worker와 맞춘 공유 비밀값 (긴 무작위 문자열)
//
// 요청(POST JSON): { secret, model, payload }
// 응답(JSON)    : { status, body }  또는  { status, error }
//   Apps Script 웹앱은 HTTP 상태코드를 바꿀 수 없어 status를 본문에 담습니다.
// =====================================================================

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('RELAY_SECRET');
  var key = props.getProperty('GEMINI_API_KEY');
  if (!secret || !key) return out_({ status: 500, error: '스크립트 속성(RELAY_SECRET, GEMINI_API_KEY)이 없습니다' });

  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ status: 400, error: '잘못된 요청 형식' });
  }
  if (!req || req.secret !== secret) return out_({ status: 401, error: '중계 비밀값이 맞지 않습니다' });

  var model = String(req.model || '');
  if (!/^[a-z0-9.\-]+$/.test(model)) return out_({ status: 400, error: '모델 이름이 올바르지 않습니다' });

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(req.payload || {}),
      muteHttpExceptions: true,
    }
  );

  var text = res.getContentText();
  var body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = { error: { message: String(text).slice(0, 300) } };
  }
  return out_({ status: res.getResponseCode(), body: body });
}

// 배포 확인용: 브라우저로 웹앱 주소를 열면 {"ok":true}가 보이면 정상
function doGet() {
  return out_({ ok: true });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
