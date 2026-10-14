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
const PRICE_SHEET = '價目表';   // 試算用；第一次試算時自動建立，之後直接在試算表改價格
const MANAGER_PV = 220000;      // 經理門檻
const CASH_GIFT_AMOUNT = 20000; // 現金滿 2 萬送 30 顆一瓶
const HISTORY_TURNS = 12;      // 送給 AI 的聊天則數（LINE 與 Telegram 共用）
const TOMBSTONE_DAYS = 60;     // 刪除紀錄保留天數
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const HELP_TEXT = [
  '直接跟小乖說話就好，例如：',
  '・明天下午三點提醒我打電話給媽媽',
  '・幫我記下：車位在 B2-35',
  '・我這週有什麼行程？',
  '・傳訂單圖片，說明欄打「試算」，小乖會算出每項數量、金額和 PV',
  '・也可以直接打字：試算 211 2盒、777Q 1盒',
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

  // 網頁 AI 代理（ai-proxy/AiProxy.gs 一起貼進專案後才會啟用）
  if (body.action === 'openai' && typeof handleAiProxy_ === 'function') return handleAiProxy_(body);

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
    if (owner && uid === owner) reply_(ev.replyToken, image_('', lineImage_(ev.message.id)));
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
  const q = text.match(/^試算[\s：:]*([\s\S]*)$/);
  if (q) {
    if (q[1].trim()) return quote_(q[1].trim());
    setProp_('QUOTE_UNTIL', String(Date.now() + 10 * 60 * 1000));
    return '好，請傳訂單圖片給我，我來算數量、金額和 PV。';
  }
  return chat_(text);
}

// 圖片：說明以「試算」開頭（或像「幫我算金額」），或 10 分鐘內先傳過「試算」，就走試算；否則一般看圖
function image_(text, image) {
  const pending = Number(prop_('QUOTE_UNTIL')) > Date.now();
  const t = String(text || '').trim();
  if (pending || /^(試算|計算|算)/.test(t) || /算.{0,4}(金額|PV)/i.test(t)) {
    setProp_('QUOTE_UNTIL', '0');
    return quote_(t.replace(/^(試算|計算|算)\s*/, ''), image);
  }
  return chat_(text, image);
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
    return tgSend_(chatId, image_(text, img));
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
    // 看圖時不帶舊對話：以前「看不到圖片」的回覆會讓模型跟著拒絕
    out = callOpenAI_(buildSys_(data), (image ? [] : history).concat([{ role: 'user', content: content }]));
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

/* ============ 試算（金額與 PV） ============ */
// AI 只負責「看出表上寫了什麼」，盒數、金額、PV 一律由程式照價目表計算，不讓 AI 心算。
// 支援兩種輸入：
//   1. 草本產品購買明細表：每個月一欄（服用 N 月），每列「編號＋每次顆數＋早中晚打勾」，另有「保養」欄
//   2. 一般訂單或打字清單：直接寫品項和盒數（例如「211 2盒」）
const DAYS_PER_MONTH = 30;
// 一組＝4 盒的優惠組合；買到 4 盒以上自動換成組合價（2711AB 組合限 2 組）
const PACKS = {
  '2711AB': { single: '2711AB(1)限8盒', set: '2711AB(4)限2組', size: 4, maxSets: 2 },
  '777Q': { single: '777Q', set: '777Q(4)', size: 4, maxSets: 99 },
};
const CODE_ALIAS = { '火山甘露茶': '火山甘露' };
const CAPPED = ['168', '111', '101'];   // SOP：三個月購買上限 4 盒
const CAP_BOXES = 4;

function quote_(text, image) {
  if (!prop_('OPENAI_API_KEY')) return '還沒設定 OpenAI 金鑰，請到 Apps Script 的指令碼屬性填入 OPENAI_API_KEY。';
  const prices = prices_();
  const sys = '你是訂單辨識助手，負責把圖片或文字轉成 JSON，不要計算金額。\n'
    + '【情況一：草本產品購買明細表】表上有「一、二、三」（或第一、二、三個月）幾欄，每欄標題有「服用 N 月」，'
    + '也可能在欄位底下用紅筆寫「吃3個月」；沒寫月數就當 1。每列有「編號」（印好的或手寫，例如 211、300、299A、211A、255A、2711AB、777Q、260）、'
    + '「顆數」（每次吃幾顆）、「早／中／晚」打勾。只收「顆數有寫數字」的列；顆數空白的列（例如沒用到的月份裡印好的 211）不要收。'
    + 'times 是該列有幾個時段要吃：表格的早、晚通常是印好的勾，就算 2；中也有勾才算 3。'
    + '整欄都沒寫顆數的月份不要放。最右邊的「保養」欄放進 maintenance。左上角有日期、地點，姓名、介紹人照抄。'
    + '手寫的 2 常寫得像 >，例如「>60」是 260、「>55A」是 255A、「>711AB」是 2711AB、「7770」「777Q」是 777Q。\n'
    + '【情況二：一般訂單或打字清單】直接寫品項和數量（盒）的，放進 items，name 要一字不差照抄價目表品項，數量沒寫就當 1。\n'
    + '對應不到價目表的放進 unknown（照原文）。\n'
    + '只輸出 JSON：{"name":"","introducer":"","date":"",'
    + '"periods":[{"label":"第一個月","months":1,"rows":[{"code":"211","perDose":3,"times":2}]}],'
    + '"maintenance":[{"code":"211","perDose":3,"times":2}],'
    + '"items":[{"name":"價目表品項","qty":1}],"unknown":["原文"]}\n\n'
    + '價目表品項：\n' + prices.map(p => p.name).join('\n');
  const user = image
    ? [{ type: 'text', text: text || '請辨識這張訂單／購買明細表' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }]
    : text;
  let parsed;
  try {
    parsed = JSON.parse(callOpenAI_(sys, [{ role: 'user', content: user }], true));
  } catch (err) {
    console.error(err);
    return '抱歉，這次沒辨識成功（' + err.message + '），再傳一次看看。';
  }
  const answer = quoteText_(computeQuote_(prices, parsed));
  logChat_('user', (image ? '（傳了一張訂單圖片要試算）' : '試算 ') + (text || ''));
  logChat_('assistant', answer);
  return answer;
}

// 把辨識結果換算成購買清單：明細表依「每次顆數 × 時段 × 30 天 × 月數 ÷ 每盒顆數」無條件進位成盒數
function computeQuote_(prices, parsed) {
  const byName = {};
  prices.forEach(p => { byName[normName_(p.name)] = p; });
  const find = code => {
    const k = normName_(CODE_ALIAS[normName_(code)] || code);
    return byName[k] || null;
  };
  const num = (v, d) => { const n = Number(String(v == null ? '' : v).normalize('NFKC')); return n > 0 ? n : d; };
  const unknown = (parsed.unknown || []).map(String).filter(Boolean);
  const boxes = {}, order = [];
  const add = (key, n) => { if (!boxes[key]) { boxes[key] = 0; order.push(key); } boxes[key] += n; };

  // 某個編號在一段期間要幾盒
  const boxesFor = (code, perDose, times, months) => {
    const pack = PACKS[normName_(code)];
    const p = pack ? byName[normName_(pack.single)] : find(code);
    if (!p) return null;
    const pills = perDose * times * DAYS_PER_MONTH * months;
    return { key: pack ? normName_(code) : p.name, n: Math.ceil(pills / (p.perBox || 90)) };
  };

  const periods = [];
  (parsed.periods || []).forEach((pd, i) => {
    const months = num(pd && pd.months, 1);
    const rows = [];
    ((pd && pd.rows) || []).forEach(r => {
      const code = String((r && r.code) || '').trim();
      const perDose = num(r && r.perDose, 0);
      if (!code || !perDose) return;
      const times = Math.min(3, num(r.times, 2));
      const b = boxesFor(code, perDose, times, months);
      if (!b) { unknown.push(code); return; }
      add(b.key, b.n);
      rows.push(code + '(' + perDose + ')');
    });
    if (rows.length) periods.push({ label: String((pd && pd.label) || '第' + (i + 1) + '段'), months: months, rows: rows });
  });
  const isSheet = periods.length > 0;
  if (isSheet) {
    const tea = find('火山甘露');
    if (tea && !boxes[tea.name]) add(tea.name, 1);   // 表上：火山甘露茶第一個月一盒即可
  }

  (parsed.items || []).forEach(it => {
    const name = String((it && it.name) || '').trim();
    const qty = Math.max(1, Math.round(num(it && it.qty, 1)));
    const pack = PACKS[normName_(name)];
    const p = pack ? null : find(name);
    if (pack) add(normName_(name), qty);
    else if (p) add(p.name, qty);
    else if (name) unknown.push(name);
  });

  // 換成價目表上的實際品項（4 盒以上自動用組合價）
  const lines = [];
  const warn = [];
  order.forEach(key => {
    const n = boxes[key];
    const pack = PACKS[key];
    if (pack) {
      const sets = Math.min(Math.floor(n / pack.size), pack.maxSets);
      const singles = n - sets * pack.size;
      if (sets) lines.push(line_(byName[normName_(pack.set)], sets, key + ' ' + sets * pack.size + ' 盒'));
      if (singles) lines.push(line_(byName[normName_(pack.single)], singles, key + ' ' + singles + ' 盒'));
    } else {
      lines.push(line_(byName[normName_(key)], n));
    }
    if (CAPPED.indexOf(key) >= 0 && n > CAP_BOXES) warn.push(key + ' 共 ' + n + ' 盒，超過三個月上限 ' + CAP_BOXES + ' 盒');
  });

  const maint = [];
  ((parsed.maintenance) || []).forEach(r => {
    const code = String((r && r.code) || '').trim();
    const perDose = num(r && r.perDose, 0);
    if (!code || !perDose) return;
    const b = boxesFor(code, perDose, Math.min(3, num(r.times, 2)), 1);
    if (!b) { unknown.push(code); return; }
    const pack = PACKS[b.key];
    maint.push(line_(byName[normName_(pack ? pack.single : b.key)], b.n, code + '(' + perDose + ')'));
  });

  return {
    name: String(parsed.name || ''), introducer: String(parsed.introducer || ''), date: String(parsed.date || ''),
    isSheet: isSheet, periods: periods, lines: lines.filter(Boolean), maint: maint.filter(Boolean),
    unknown: unknown.filter((x, i, a) => a.indexOf(x) === i), warn: warn,
  };
}

function line_(p, qty, label) {
  if (!p) return null;
  return { name: p.name, label: label || p.name, qty: qty, price: p.price * qty, pv: p.pv * qty };
}

function quoteText_(r) {
  if (!r.lines.length) {
    return '我沒從裡面找到價目表上的品項' + (r.unknown.length ? '（看到：' + r.unknown.join('、') + '）' : '')
      + '。可以拍清楚一點再傳，或直接打字：試算 211 2盒、777Q 1盒';
  }
  const n = x => Number(x).toLocaleString('en-US');
  const out = ['🧾 試算結果'];
  const who = [r.name, r.introducer ? '介紹人 ' + r.introducer : '', r.date].filter(Boolean).join('｜');
  if (who) out.push(who);
  if (r.isSheet) {
    out.push('', '【看到的內容】（括號是每次顆數）');
    r.periods.forEach(pd => out.push(pd.label + '（服用 ' + pd.months + ' 個月）：' + pd.rows.join('、')));
  }
  out.push('', '【購買明細】');
  let boxes = 0, amount = 0, pv = 0;
  r.lines.forEach(l => {
    boxes += l.qty; amount += l.price; pv += l.pv;
    const unit = l.label !== l.name ? l.label + '（' + l.name + ' × ' + l.qty + '）' : l.name + ' × ' + l.qty;
    out.push(unit);
    out.push('　金額 ' + n(l.price) + '｜PV ' + n(l.pv));
  });
  out.push('', '總金額：' + n(amount) + ' 元', '總 PV：' + n(pv));
  out.push(pv >= MANAGER_PV ? '✅ 已達經理 ' + n(MANAGER_PV) + ' PV' : '距經理 ' + n(MANAGER_PV) + ' PV 還差 ' + n(MANAGER_PV - pv));
  if (amount >= CASH_GIFT_AMOUNT) out.push('💡 現金購買滿 2 萬，送 30 顆一瓶（刷卡沒有）');
  if (r.maint.length) {
    let ma = 0, mp = 0;
    out.push('', '【保養：之後每個月】');
    r.maint.forEach(l => { ma += l.price; mp += l.pv; out.push(l.label + ' → ' + l.name + ' × ' + l.qty); });
    out.push('每月金額：' + n(ma) + ' 元｜PV ' + n(mp) + '（不含在上面的總計）');
  }
  r.warn.forEach(w => out.push('⚠️ ' + w));
  if (r.unknown.length) out.push('', '⚠️ 這些我對不到價目表，沒算進去：' + r.unknown.join('、'));
  out.push('', r.isSheet ? '盒數＝每次顆數 × 時段 × 30 天 × 月數 ÷ 每盒顆數（無條件進位）。字是辨識出來的，請再核對一次。'
    : '數量是辨識出來的，請再核對一次。');
  return out.join('\n');
}

// 全形半形、空白、括號統一，避免「(Ａ)」「（A）」對不上
function normName_(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

function prices_() {
  const ss = ss_();
  let sh = ss.getSheetByName(PRICE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PRICE_SHEET);
    const rows = DEFAULT_PRICES.map(l => l.split('|')).map(r => [r[0], Number(r[1]), Number(r[2]), Number(r[3] || 90)]);
    sh.getRange(1, 1, 1, 4).setValues([['品項', 'PV', '金額', '每盒顆數']]).setFontWeight('bold');
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
    sh.setFrozenRows(1);
  }
  const last = sh.getLastRow();
  if (last < 2) return [];
  const num = v => Number(String(v).normalize('NFKC').replace(/[,\s]/g, '')) || 0;
  return sh.getRange(2, 1, last - 1, 4).getValues()
    .filter(r => String(r[0]).trim())
    .map(r => ({ name: String(r[0]).trim(), pv: num(r[1]), price: num(r[2]), perBox: num(r[3]) || 90 }));
}

// 第一次試算時寫進「價目表」分頁（品項|PV|金額|每盒顆數，沒寫每盒顆數就是 90）；之後改價格請直接改試算表，不用改這裡
const DEFAULT_PRICES = [
  '新入會(9號）|17280|29800',
  '新入會(草本）男|9000|15400',
  '新入會(草本）女|9000|15400',
  '2711AB(1)限8盒|3600|4880|60',
  '2711AB(4)限2組|12600|17920|60',
  '211|2160|2960',
  '300|2160|2980',
  '299A|2280|3240',
  '火山甘露|2250|3220',
  '200|2280|3240',
  '201|2160|2960',
  '202|2160|2880',
  '205|2160|2880',
  '209|2280|3240',
  '210|2280|3240',
  '211A|2280|3240',
  '220|2160|2960',
  '222|2280|3240',
  '233|2160|2960',
  '240|2160|2960',
  '255A|2280|3240',
  '260|2160|2960',
  '266|2160|2960',
  '268|2280|3240',
  '270|2280|3240',
  '280|2160|2880',
  '286|2160|2880',
  '288|2160|2880',
  '289|2280|3240',
  '290|2160|2960',
  '295|2160|2980',
  '299|2280|3240',
  '701|2160|2980',
  '702|2160|2880',
  '703|2160|2880',
  '705|2160|2880',
  '706|2160|2880',
  '707|2160|2880',
  '708|2280|3240',
  '747AB|2880|4000',
  '777Q|3600|4880',
  '777Q(4)|12600|17920',
  '大女王|7680|10240',
  '極樂鳥|2880|4000',
  '101|2160|2880',
  '111|2280|3240',
  '168|2280|3240',
  '金色果(2）|2000|3040',
  '海神泥|2250|3050',
  '復甦精華露|2160|2960',
  '潔面乳|1350|1880',
  '玫瑰化妝水|1350|1880',
  '植萃粉底乳|800|1120',
  '彼拉提斯精油|2160|2960',
  '隱形面膜|1800|2480',
  '命運1號|2700|3680',
  '命運9號（2)|9720|12960',
  '冰晶球（大）|4050|5550',
  '冰晶球（小）|3900|5350',
  '親密潔淨露 (3)|3150|4320',
  '密集保濕精華液|2100|2880',
  '保濕澎潤日霜|1350|1800',
  '閃耀眼膜|2100|2880',
  '深層保濕再生精萃|1050|1450',
  '保濕全能日霜|2100|2880',
  '水光肌黃金精萃|2900|3980',
  '青春眼膠|1350|1880',
  '紓壓晚霜|2100|2960',
  '緊緻濃縮精華液|3000|4080',
  '逆齡晚霜|4050|5550',
  '淡斑修護霜|2000|2700',
  '逆齡眼霜|2100|2880',
  '贈品 211(30)|0|0',
  '入*會「 211 」|0|0',
  '入*會「 101 」|0|0',
  '入*會「 707 」|0|0',
  '入*會「 9號兩組」|0|0',
  '女人三寶(Ａ)|52560|74760',
  '女人三寶(Ｂ)|77520|108280',
  '男人三寶(Ａ)|35760|52760',
  '男人三寶(Ｂ)|48360|70680',
  '駐顏回春(Ａ)|51840|75640',
  '駐顏回春(Ｂ)|71280|101560'
];

/* ============ OpenAI ============ */
function callOpenAI_(system, messages, asJson) {
  const model = prop_('MODEL') || 'gpt-4o-mini';
  const body = { model: model, messages: [{ role: 'system', content: system }].concat(messages) };
  if (asJson) body.response_format = { type: 'json_object' };
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
    + '你看得懂使用者傳來的圖片：收到圖片就直接讀出內容，不要說你看不到圖片。\n'
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
