/**
 * 私人助理小乖：LINE 官方帳號 + Telegram + 雲端同步（Google Apps Script）
 *
 * 一支程式做三件事：
 *  1. LINE Webhook：在 LINE 跟小乖聊天，小乖用 OpenAI 回話，並能幫你新增待辦、行程、提醒、筆記。
 *  2. Telegram Webhook：在 Telegram 跟小乖聊天，功能與 LINE 相同。LINE、Telegram 可以只接其中一個。
 *  3. 雲端同步：Assistant.html 把待辦、行程、提醒、筆記同步到這份試算表，LINE、Telegram 與網頁看到同一份資料。
 * 另外每 5 分鐘檢查一次提醒，時間到就用 LINE／Telegram 通知你。
 *
 * 設定步驟請看同資料夾的 README.md。
 */

const TZ = 'Asia/Taipei';
const COLS = ['todos', 'events', 'reminders', 'notes'];
const SHEETS = {
  todos: '待辦', events: '行程', reminders: '提醒', notes: '筆記',
  deleted: '刪除紀錄', profile: '個人資料', chat: '聊天紀錄',
};
const HISTORY_TURNS = 12;      // 送給 AI 的聊天則數（LINE 與 Telegram 共用）
const TOMBSTONE_DAYS = 60;     // 刪除紀錄保留天數
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const HELP_TEXT = [
  '直接跟小乖說話就好，例如：',
  '・明天下午三點提醒我打電話給媽媽',
  '・幫我記下：車位在 B2-35',
  '・我這週有什麼行程？',
  '・傳圖片（可加一句說明，例如「幫我記下來」），小乖會讀出內容幫你整理',
  '',
  '其他指令：',
  '・清除對話：讓小乖忘掉聊天內容（待辦、筆記等資料不會刪）',
].join('\n');

/* ============ 設定值（指令碼屬性） ============ */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }

/* ============ 一次性安裝：在編輯器選 setup 執行 ============ */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('請從試算表的「擴充功能 → Apps Script」開啟這份程式，再執行 setup。');
  setProp_('SHEET_ID', ss.getId());

  const headers = {
    todos: ['id', '更新時間', '摘要', '資料（請勿手動修改）'],
    events: ['id', '更新時間', '摘要', '資料（請勿手動修改）'],
    reminders: ['id', '更新時間', '摘要', '資料（請勿手動修改）'],
    notes: ['id', '更新時間', '摘要', '資料（請勿手動修改）'],
    deleted: ['id', '刪除時間（毫秒）'],
    profile: ['資料（請勿手動修改）'],
    chat: ['時間', '角色', '內容'],
  };
  Object.keys(SHEETS).forEach(k => {
    const sh = ss.getSheetByName(SHEETS[k]) || ss.insertSheet(SHEETS[k]);
    sh.getRange(1, 1, 1, headers[k].length).setValues([headers[k]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkReminders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkReminders').timeBased().everyMinutes(5).create();

  if (!prop_('SYNC_KEY')) setProp_('SYNC_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 12));
  if (!prop_('MODEL')) setProp_('MODEL', 'gpt-4o-mini');
  Logger.log('安裝完成！你的同步密碼是：' + prop_('SYNC_KEY'));
}

/* ============ 接上 Telegram：部署完成後在編輯器選 setupTelegram 執行 ============ */
function setupTelegram() {
  if (!prop_('TELEGRAM_BOT_TOKEN')) throw new Error('請先在指令碼屬性填入 TELEGRAM_BOT_TOKEN。');
  const base = prop_('WEBAPP_URL');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(base)) throw new Error('請先在指令碼屬性填入 WEBAPP_URL（部署後拿到、結尾是 /exec 的網址）。');
  const res = tgApi_('setWebhook', {
    url: base + '?key=' + encodeURIComponent(prop_('SYNC_KEY')),
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  Logger.log('Telegram 回應：' + res);
}

/* ============ 入口 ============ */
function doGet() {
  return ContentService.createTextOutput('小乖雲端服務運作中');
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: '格式錯誤' }); }

  // LINE Webhook（Apps Script 讀不到 X-Line-Signature，改用網址上的 key 當通關密碼）
  if (Array.isArray(body.events)) {
    if (e.parameter.key !== prop_('SYNC_KEY')) return text_('forbidden');
    body.events.forEach(ev => {
      try { handleLine_(ev); } catch (err) { console.error(err); }
    });
    return ack_();
  }

  // Telegram Webhook（同樣用網址上的 key 驗證）
  if (body.update_id !== undefined) {
    if (e.parameter.key !== prop_('SYNC_KEY')) return text_('forbidden');
    try { handleTelegram_(body); } catch (err) { console.error(err); }
    return ack_();
  }

  // 網頁同步
  if (body.action === 'sync') {
    if (!prop_('SYNC_KEY') || body.key !== prop_('SYNC_KEY')) return json_({ ok: false, error: '同步密碼錯誤' });
    const data = withLock_(() => {
      const stored = readAll_();
      const merged = merge_(stored, body.data || {});
      if (canon_(merged) !== canon_(stored)) writeAll_(merged);
      return merged;
    });
    return json_({ ok: true, data: data, now: Date.now() });
  }

  return json_({ ok: false, error: '未知的請求' });
}

/* ============ LINE ============ */
function handleLine_(ev) {
  const uid = ev.source && ev.source.userId;
  const owner = prop_('OWNER_USER_ID');
  if (ev.type === 'follow') {
    if (!owner) reply_(ev.replyToken, '嗨，我是小乖！請傳「綁定 你的同步密碼」完成綁定，之後就能在這裡跟我聊天。');
    return;
  }
  if (ev.type !== 'message' || !ev.replyToken) return;
  if (ev.message.type === 'image') {
    if (owner && uid === owner) reply_(ev.replyToken, chat_('', lineImage_(ev.message.id)));
    return;
  }
  if (ev.message.type !== 'text') {
    if (uid === owner) reply_(ev.replyToken, '小乖目前看得懂文字和圖片，其他類型還不行喔。');
    return;
  }

  const text = ev.message.text.trim();
  const bind = text.match(/^綁定\s*(\S+)$/);
  if (bind) {
    if (owner && owner !== uid) return reply_(ev.replyToken, '小乖已經有主人了。');
    if (bind[1] !== prop_('SYNC_KEY')) return reply_(ev.replyToken, '同步密碼不對喔，再確認一次。');
    setProp_('OWNER_USER_ID', uid);
    return reply_(ev.replyToken, '綁定完成！之後直接跟我說話就好。傳「說明」可以看我會做什麼。');
  }
  if (!owner) return reply_(ev.replyToken, '請先傳「綁定 你的同步密碼」完成綁定。');
  if (uid !== owner) return reply_(ev.replyToken, '小乖目前只服務主人喔。');

  reply_(ev.replyToken, answer_(text));
}

// 下載 LINE 圖片，轉成 OpenAI 看得懂的 data URL
function lineImage_(messageId) {
  const res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('LINE 圖片下載失敗');
  return dataUrl_(res.getBlob());
}

// LINE 與 Telegram 共用：說明、清除對話，其餘交給 AI
function answer_(text) {
  if (text === '說明' || /^\/?help$/i.test(text)) return HELP_TEXT;
  if (text === '清除對話') {
    const sh = sheet_('chat');
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    return '好，聊天內容我忘掉了，你的待辦和筆記都還在。';
  }
  return chat_(text);
}

/* ============ Telegram ============ */
function handleTelegram_(update) {
  // Apps Script 回應時會轉址一次，Telegram 可能因此重送同一則；用 update_id 去除重複
  const seenId = Number(prop_('TG_LAST_UPDATE_ID')) || 0;
  if (update.update_id <= seenId) return;
  setProp_('TG_LAST_UPDATE_ID', String(update.update_id));

  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const owner = prop_('TG_OWNER_CHAT_ID');
  const text = String(msg.text || msg.caption || '').trim();
  const doc = msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document : null;
  const fileId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : doc && doc.file_id;

  if (fileId) {
    if (!owner || chatId !== owner) return;
    tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
    let img;
    try { img = tgImage_(fileId, doc && doc.mime_type); }
    catch (err) { console.error(err); return tgSend_(chatId, '圖片讀取失敗，再傳一次看看。'); }
    return tgSend_(chatId, chat_(text, img));
  }
  if (!text) {
    if (chatId === owner) tgSend_(chatId, '小乖目前看得懂文字和圖片，其他類型還不行喔。');
    return;
  }
  if (/^\/start\b/.test(text) && !owner) return tgSend_(chatId, '嗨，我是小乖！請傳「綁定 你的同步密碼」完成綁定，之後就能在這裡跟我聊天。');
  const bind = text.match(/^(?:綁定|\/bind)\s*(\S+)$/);
  if (bind) {
    if (owner && owner !== chatId) return tgSend_(chatId, '小乖已經有主人了。');
    if (bind[1] !== prop_('SYNC_KEY')) return tgSend_(chatId, '同步密碼不對喔，再確認一次。');
    setProp_('TG_OWNER_CHAT_ID', chatId);
    return tgSend_(chatId, '綁定完成！之後直接跟我說話就好。傳「說明」可以看我會做什麼。');
  }
  if (!owner) return tgSend_(chatId, '請先傳「綁定 你的同步密碼」完成綁定。');
  if (chatId !== owner) return tgSend_(chatId, '小乖目前只服務主人喔。');

  tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
  tgSend_(chatId, answer_(text.replace(/^\/start\b\s*/, '') || '說明'));
}

// 下載 Telegram 圖片，轉成 OpenAI 看得懂的 data URL
function tgImage_(fileId, mime) {
  const info = JSON.parse(tgApi_('getFile', { file_id: fileId }));
  if (!info.ok) throw new Error('Telegram getFile 失敗');
  const res = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/' + info.result.file_path, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Telegram 圖片下載失敗');
  return dataUrl_(res.getBlob(), mime || 'image/jpeg');
}

function dataUrl_(blob, mime) {
  const type = mime || blob.getContentType() || 'image/jpeg';
  return 'data:' + type + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function tgSend_(chatId, text) {
  tgApi_('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) });
}

function tgApi_(method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/' + method, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  });
  if (res.getResponseCode() !== 200) console.error('Telegram ' + method + ' 失敗：' + res.getContentText());
  return res.getContentText();
}

// image：可選，data URL。聊天紀錄只存文字，所以看圖後的回覆要把圖片重點寫出來，之後的對話才接得上
function chat_(text, image) {
  const key = prop_('OPENAI_API_KEY');
  if (!key) return '還沒設定 OpenAI 金鑰，請到 Apps Script 的指令碼屬性填入 OPENAI_API_KEY。';

  const data = readAll_();
  const history = recentChat_(HISTORY_TURNS);
  logChat_('user', image ? '（傳了一張圖片）' + (text ? ' ' + text : '') : text);

  let content = text;
  if (image) {
    content = [
      { type: 'text', text: (text || '請讀取這張圖片') + '\n\n（請先把圖片中的文字與重點完整整理成條列；使用者要你記下來時，用 note 動作存成筆記。）' },
      { type: 'image_url', image_url: { url: image, detail: 'high' } },
    ];
  }

  let out;
  try {
    out = callOpenAI_(buildSys_(data), history.concat([{ role: 'user', content: content }]));
  } catch (err) {
    console.error(err);
    return '抱歉，小乖暫時想不起來（' + err.message + '），等一下再問我一次。';
  }

  const parsed = parseActions_(out);
  let done = [];
  if (parsed.acts.length) {
    done = withLock_(() => {
      const d = readAll_();
      const res = applyActions_(d, parsed.acts);
      if (res.length) writeAll_(d);
      return res;
    });
  }
  const answer = [parsed.clean || '好的！'].concat(done.length ? ['', '已幫你新增：'].concat(done) : []).join('\n');
  logChat_('assistant', answer);
  return answer;
}

function reply_(replyToken, text) {
  lineApi_('reply', { replyToken: replyToken, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] });
}

function push_(to, text) {
  lineApi_('push', { to: to, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] });
}

function lineApi_(kind, payload) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + kind, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify(payload),
  });
  if (res.getResponseCode() !== 200) console.error('LINE ' + kind + ' 失敗：' + res.getContentText());
}

/* ============ 提醒（時間驅動觸發條件，每 5 分鐘） ============ */
function checkReminders() {
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  if ((!owner && !tgOwner) || !prop_('SHEET_ID')) return;
  const due = withLock_(() => {
    const d = readAll_();
    const now = Date.now();
    const msgs = [];
    d.reminders.forEach(r => {
      if (r.fired) return;
      const t = parseAt_(r.at);
      if (!t || t > now) return;
      msgs.push('⏰ ' + r.text);
      if (r.repeat === 'daily' || r.repeat === 'weekly') {
        const step = (r.repeat === 'daily' ? 1 : 7) * 864e5;
        let nt = t;
        while (nt <= now) nt += step;
        r.at = fmtAt_(nt);
      } else {
        r.fired = true;
      }
      r.u = now;
    });
    if (msgs.length) writeAll_(d);
    return { msgs: msgs, title: (d.profile && d.profile.title) || '小乖' };
  });
  if (!due.msgs.length) return;
  const note = due.title + '提醒你：\n' + due.msgs.join('\n');
  if (owner && prop_('LINE_CHANNEL_ACCESS_TOKEN')) push_(owner, note);
  if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) tgSend_(tgOwner, note);
}

/* ============ OpenAI ============ */
function callOpenAI_(system, messages) {
  const model = prop_('MODEL') || 'gpt-4o-mini';
  const body = { model: model, messages: [{ role: 'system', content: system }].concat(messages) };
  if (/^gpt-5/.test(model)) body.max_completion_tokens = 4000;
  else { body.max_tokens = 2500; body.temperature = 0.6; }
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') },
    payload: JSON.stringify(body),
  });
  const code = res.getResponseCode();
  if (code === 401) throw new Error('OpenAI 金鑰無效');
  if (code !== 200) throw new Error('OpenAI 回應 ' + code);
  const data = JSON.parse(res.getContentText());
  return ((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim();
}

function buildSys_(d) {
  const p = d.profile || {};
  const now = new Date();
  const today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const hm = Utilities.formatDate(now, TZ, 'HH:mm');
  const dow = WEEK[Number(Utilities.formatDate(now, TZ, 'u')) % 7];
  const todos = d.todos.filter(x => !x.done).slice(0, 40)
    .map(x => '- ' + x.text + (x.due ? '（期限 ' + x.due + '）' : '') + (x.pri === 'high' ? '［重要］' : '')).join('\n') || '（無）';
  const evs = d.events.filter(e => e.date >= today).sort(evCmp_).slice(0, 30)
    .map(e => '- ' + e.date + ' ' + (e.time || '整天') + ' ' + e.title + (e.place ? '＠' + e.place : '')).join('\n') || '（無）';
  const rms = d.reminders.filter(r => !r.fired).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, 30)
    .map(r => '- ' + String(r.at).replace('T', ' ') + ' ' + r.text + (r.repeat && r.repeat !== 'none' ? '（' + (r.repeat === 'daily' ? '每天' : '每週') + '）' : '')).join('\n') || '（無）';
  const notes = d.notes.slice(0, 15)
    .map(n => '- ' + (n.title || '（無標題）') + '：' + String(n.body || '').replace(/\s+/g, ' ').slice(0, 120)).join('\n') || '（無）';
  return '你是「' + (p.title || '小乖') + '」，' + (p.nick || '使用者') + '的私人助理。個性貼心、可靠、說話簡潔溫暖，一律用繁體中文（台灣用語）。\n'
    + '你現在在 LINE 或 Telegram 上聊天：回覆要短，不要用 Markdown 標題、表格或粗體。\n'
    + '現在時間：' + today + ' ' + hm + '（星期' + dow + '）。\n\n'
    + '【關於使用者】\n' + (p.about || '（尚未填寫）') + '\n\n'
    + '【目前未完成待辦】\n' + todos + '\n\n'
    + '【接下來的行程】\n' + evs + '\n\n'
    + '【尚未觸發的提醒】\n' + rms + '\n\n'
    + '【最近筆記】\n' + notes + '\n\n'
    + '【你可以直接幫使用者新增資料】\n'
    + '當使用者要你記下、安排、提醒某件事時，先用一兩句話回覆確認，然後在回覆最後附上一個 ```actions 程式碼區塊，內容是 JSON 陣列，格式如下（只放需要的項目，日期時間一律換算成絕對值）：\n'
    + '```actions\n'
    + '[\n'
    + '  {"type":"todo","text":"繳電話費","due":"YYYY-MM-DD","pri":"normal 或 high"},\n'
    + '  {"type":"event","title":"牙醫回診","date":"YYYY-MM-DD","time":"HH:MM","place":"地點"},\n'
    + '  {"type":"reminder","text":"打電話給媽媽","at":"YYYY-MM-DDTHH:MM","repeat":"none 或 daily 或 weekly"},\n'
    + '  {"type":"note","title":"標題","body":"內容"}\n'
    + ']\n'
    + '```\n'
    + '沒有要新增東西時，不要附 actions 區塊。不要捏造使用者沒提過的行程。';
}

function parseActions_(text) {
  const m = text.match(/```actions\s*([\s\S]*?)```/);
  if (!m) return { clean: text.trim(), acts: [] };
  let arr = [];
  try { arr = JSON.parse(m[1].trim()); if (!Array.isArray(arr)) arr = [arr]; } catch (e) { arr = []; }
  return { clean: text.replace(m[0], '').trim(), acts: arr };
}

// 與 Assistant.html 的 applyActions 相同規則，另外加上更新時間 u 供同步使用
function applyActions_(d, acts) {
  const now = Date.now();
  const done = [];
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  acts.forEach(a => {
    if (!a || typeof a !== 'object') return;
    if (a.type === 'todo' && a.text) {
      d.todos.unshift({ id: uid_(), text: String(a.text).slice(0, 120), due: isDate(a.due) ? a.due : '',
        pri: a.pri === 'high' ? 'high' : 'normal', done: false, time: now, u: now });
      done.push('✅ 待辦：' + a.text);
    } else if (a.type === 'event' && a.title && isDate(a.date)) {
      const ev = { id: uid_(), title: String(a.title).slice(0, 80), date: a.date,
        time: /^\d{2}:\d{2}$/.test(a.time || '') ? a.time : '', place: String(a.place || '').slice(0, 80), time0: now, u: now };
      d.events.push(ev);
      done.push('🗓️ 行程：' + ev.date + ' ' + ev.time + ' ' + ev.title);
    } else if (a.type === 'reminder' && a.text && parseAt_(String(a.at || '').slice(0, 16))) {
      const at = String(a.at).slice(0, 16);
      d.reminders.push({ id: uid_(), text: String(a.text).slice(0, 120), at: at,
        repeat: ['daily', 'weekly'].indexOf(a.repeat) >= 0 ? a.repeat : 'none', fired: false, u: now });
      done.push('⏰ 提醒：' + at.replace('T', ' ') + ' ' + a.text);
    } else if (a.type === 'note' && (a.title || a.body)) {
      d.notes.unshift({ id: uid_(), title: String(a.title || '').slice(0, 60), body: String(a.body || ''), time: now, u: now });
      done.push('📝 筆記：' + (a.title || '（無標題）'));
    }
  });
  return done;
}

/* ============ 同步：合併規則 ============ */
// 每筆資料以 id 對應，較新的 u（更新時間）勝出；刪除紀錄比資料新就刪掉。
// Assistant.html 裡有一份相同的 mergeSync()，兩邊規則要一致。
function merge_(a, b) {
  const out = { deleted: {} };
  [a.deleted || {}, b.deleted || {}].forEach(src => Object.keys(src).forEach(id => {
    if (!(out.deleted[id] >= src[id])) out.deleted[id] = Number(src[id]) || 0;
  }));
  const cut = Date.now() - TOMBSTONE_DAYS * 864e5;
  Object.keys(out.deleted).forEach(id => { if (out.deleted[id] < cut) delete out.deleted[id]; });
  COLS.forEach(c => {
    const m = {};
    (a[c] || []).concat(b[c] || []).forEach(x => {
      if (!x || !x.id) return;
      const p = m[x.id];
      if (!p || (x.u || 0) > (p.u || 0)) m[x.id] = x;
    });
    out[c] = Object.keys(m).map(k => m[k]).filter(x => !(out.deleted[x.id] >= (x.u || 0)));
    if (c === 'todos' || c === 'notes') out[c].sort((x, y) => (y.time || 0) - (x.time || 0));
  });
  const pa = a.profile || {}, pb = b.profile || {};
  out.profile = (pb.u || 0) > (pa.u || 0) ? pb : pa;
  return out;
}

/* ============ 試算表存取 ============ */
function ss_() { return SpreadsheetApp.openById(prop_('SHEET_ID')); }
function sheet_(k) { return ss_().getSheetByName(SHEETS[k]); }

function readAll_() {
  const ss = ss_();
  const d = { deleted: {}, profile: {} };
  COLS.forEach(c => {
    const sh = ss.getSheetByName(SHEETS[c]);
    const n = sh.getLastRow() - 1;
    d[c] = n < 1 ? [] : sh.getRange(2, 4, n, 1).getValues()
      .map(r => { try { return JSON.parse(r[0]); } catch (e) { return null; } })
      .filter(Boolean);
  });
  const del = ss.getSheetByName(SHEETS.deleted);
  if (del.getLastRow() > 1) {
    del.getRange(2, 1, del.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0]) d.deleted[r[0]] = Number(r[1]) || 0; });
  }
  const pf = ss.getSheetByName(SHEETS.profile);
  if (pf.getLastRow() > 1) { try { d.profile = JSON.parse(pf.getRange(2, 1).getValue()) || {}; } catch (e) { d.profile = {}; } }
  return d;
}

function writeAll_(d) {
  const ss = ss_();
  COLS.forEach(c => {
    const rows = (d[c] || []).map(x => [x.id, fmtTime_(x.u), summary_(c, x), JSON.stringify(x)]);
    replaceRows_(ss.getSheetByName(SHEETS[c]), rows, 4);
  });
  replaceRows_(ss.getSheetByName(SHEETS.deleted), Object.keys(d.deleted || {}).map(id => [id, d.deleted[id]]), 2);
  replaceRows_(ss.getSheetByName(SHEETS.profile), [[JSON.stringify(d.profile || {})]], 1);
}

function replaceRows_(sh, rows, width) {
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function summary_(c, x) {
  if (c === 'todos') return (x.done ? '✓ ' : '') + x.text + (x.due ? '（期限 ' + x.due + '）' : '');
  if (c === 'events') return x.date + ' ' + (x.time || '整天') + ' ' + x.title + (x.place ? '＠' + x.place : '');
  if (c === 'reminders') return String(x.at).replace('T', ' ') + ' ' + x.text + (x.fired ? '（已提醒）' : '');
  return x.title || String(x.body || '').slice(0, 40);
}

function recentChat_(n) {
  const sh = sheet_('chat');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  const rows = sh.getRange(start, 2, last - start + 1, 2).getValues();
  const msgs = rows.filter(r => r[0] === 'user' || r[0] === 'assistant').map(r => ({ role: r[0], content: String(r[1]) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function logChat_(role, content) {
  const sh = sheet_('chat');
  sh.appendRow([new Date(), role, content]);
  if (sh.getLastRow() > 501) sh.deleteRows(2, sh.getLastRow() - 501);
}

/* ============ 小工具 ============ */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
// 比較用：忽略陣列順序
function canon_(d) {
  const o = {};
  COLS.forEach(c => { o[c] = (d[c] || []).map(x => JSON.stringify(x)).sort(); });
  o.deleted = Object.keys(d.deleted || {}).sort().map(k => k + ':' + d.deleted[k]);
  o.profile = d.profile || {};
  return JSON.stringify(o);
}
function evCmp_(a, b) { return (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')); }
function parseAt_(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ''))) return 0;
  return Utilities.parseDate(s, TZ, "yyyy-MM-dd'T'HH:mm").getTime();
}
function fmtAt_(ms) { return Utilities.formatDate(new Date(ms), TZ, "yyyy-MM-dd'T'HH:mm"); }
function fmtTime_(ms) { return ms ? Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd HH:mm') : ''; }
function uid_() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function text_(s) { return ContentService.createTextOutput(s); }
// Webhook 回應：ContentService 會先轉址（302），Telegram 會當成失敗而重送、拖慢後面的訊息；HtmlService 直接回 200
function ack_() { return HtmlService.createHtmlOutput('OK'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
