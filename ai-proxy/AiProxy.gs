/**
 * 小乖 AI 代理：網頁（Work.html、trade.html、Assistant.html）透過這裡呼叫 OpenAI。
 * OpenAI 金鑰只放在指令碼屬性 OPENAI_API_KEY，不會出現在瀏覽器。
 *
 * 網頁送來：{ action: 'openai', key: 通行碼, body: { model, messages, ... } }
 * 回傳：{ ok, status, data | error }（Apps Script 一律回 HTTP 200，真正狀態看 status）
 *
 * 通行碼：指令碼屬性 SYNC_KEY（和 line-bot 的同步密碼共用）或 AI_PASSCODE，符合其中一個即可。
 * 設定步驟請看同資料夾的 README.md。
 */

const AI_ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-5-mini'];
const AI_MAX_TOKENS = 4000;     // 單次回覆上限
const AI_DAILY_LIMIT = 500;     // 每日呼叫上限，通行碼外洩時也不會被刷爆

function handleAiProxy_(req) {
  const props = PropertiesService.getScriptProperties();
  const passes = [props.getProperty('SYNC_KEY'), props.getProperty('AI_PASSCODE')].filter(Boolean);
  if (!req.key || passes.indexOf(req.key) < 0) return aiJson_({ ok: false, status: 401, error: '通行碼錯誤' });
  if (!props.getProperty('OPENAI_API_KEY')) return aiJson_({ ok: false, status: 400, error: 'Apps Script 尚未設定 OPENAI_API_KEY' });

  const body = req.body || {};
  if (AI_ALLOWED_MODELS.indexOf(body.model) < 0) return aiJson_({ ok: false, status: 400, error: '不允許的模型：' + body.model });
  if (!Array.isArray(body.messages) || !body.messages.length) return aiJson_({ ok: false, status: 400, error: '缺少對話內容' });
  delete body.stream;
  ['max_tokens', 'max_completion_tokens'].forEach(k => {
    if (body[k] !== undefined) body[k] = Math.min(Number(body[k]) || AI_MAX_TOKENS, AI_MAX_TOKENS);
  });
  if (!aiCountToday_()) return aiJson_({ ok: false, status: 403, error: '今天的 AI 呼叫次數已達上限（' + AI_DAILY_LIMIT + ' 次），明天會自動恢復' });

  const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + props.getProperty('OPENAI_API_KEY') },
    payload: JSON.stringify(body),
  });
  const status = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (status === 200) return aiJson_({ ok: true, status: status, data: data });
  const msg = (data.error && data.error.message) || ('OpenAI 回應 HTTP ' + status);
  return aiJson_({ ok: false, status: status, error: status === 401 ? 'Apps Script 裡的 OpenAI 金鑰無效：' + msg : msg });
}

// 每日計數；換日時順手清掉前幾天的紀錄
function aiCountToday_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'AI_COUNT_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
    const n = Number(props.getProperty(key) || 0) + 1;
    if (n > AI_DAILY_LIMIT) return false;
    if (n === 1) props.getKeys().filter(k => k.indexOf('AI_COUNT_') === 0 && k !== key).forEach(k => props.deleteProperty(k));
    props.setProperty(key, String(n));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function aiJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
