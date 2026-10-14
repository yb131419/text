/**
 * 沒有架 line-bot 時才需要這個檔案：讓 AiProxy.gs 單獨部署成網頁應用程式。
 * 已經在用 line-bot 的話，不要加這個檔案（一個專案只能有一個 doPost），改照 README.md 的方法 A。
 */
function doGet() {
  return ContentService.createTextOutput('小乖 AI 代理運作中');
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { return aiJson_({ ok: false, status: 400, error: '格式錯誤' }); }
  if (body.action === 'openai') return handleAiProxy_(body);
  return aiJson_({ ok: false, status: 400, error: '未知的請求' });
}
