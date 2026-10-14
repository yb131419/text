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
// 以下規則對齊「彥彬試算系統」（康園試算報表）
const TARGETS_PV = [220000, 300000];
const CASH_GIFT_AMOUNT = 20000;    // 現金每滿 2 萬，送「贈品 211(30)」一瓶；刷卡沒有
const GIFT_NAME = '贈品 211(30)';
const DAYS_PER_BOX = 15;           // 預估天數＝2 字頭品項最高盒數 × 15 天
const NEW_MEMBER_PV = 20000;       // 有新入會時，總 PV 要先滿 2 萬才有獎金
const BONUS_RATES = {
  '非經理': [[280000, 0.23], [220000, 0.20], [160000, 0.16], [100000, 0.12], [50000, 0.06], [10000, 0.03]],
  '經理': [[220000, 0.24], [160000, 0.21], [100000, 0.18], [48000, 0.08], [4000, 0.04]],
};
const HISTORY_TURNS = 12;      // 送給 AI 的聊天則數（LINE 與 Telegram 共用）
const TOMBSTONE_DAYS = 60;     // 刪除紀錄保留天數
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const HELP_TEXT = [
  '直接跟小乖說話就好，例如：',
  '・明天下午三點提醒我打電話給媽媽',
  '・幫我記下：車位在 B2-35',
  '・我這週有什麼行程？',
  '・直接傳購買明細表或訂單圖片，小乖會先問四題：「現金／刷卡」「要買多少 PV 或金額」「要買滿幾個月」「入會方式（女生／男生／九號／舊會員）」，再算出數量、金額和 PV（試算中打「取消」可中止）',
  '・也可以直接打字：試算 211 2盒、777Q 1盒',
  '・說明欄可以先寫答案：例如「現金 22萬 3個月 男」就不用再問',
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
    if (owner && uid === owner) { const ans = image_('', lineImage_(ev.message.id)); const rp = reportLine_(); reply_(ev.replyToken, rp.short || ans, rp.msgs); }
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

  const ans = answer_(text);
  const rp = reportLine_();
  reply_(ev.replyToken, rp.short || ans, rp.msgs);
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
  // 明細表試算進行中：回答「現金／刷卡」「買多少」
  const st = quoteState_();
  if (st) {
    if (/^取消/.test(text)) { clearQuoteState_(); return '好，這次試算先取消。'; }
    if (sheetEdit_(st, text)) {
      logChat_('user', text);
      st.asked = false;   // 改完重新列出看到的內容
      return askOrQuote_(prices_(), st);
    }
    const o = quoteOpts_(text);
    if (o.targetImplied && st.opts.target) { delete o.target; }
    delete o.targetImplied;
    if (o.card !== undefined || o.target || o.months || (text.length <= 6 && (o.gender || o.newMember === false))) {
      logChat_('user', text);
      Object.assign(st.opts, o);
      return askOrQuote_(prices_(), st);
    }
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
  const quoteWords = /^(試算|計算|算)|算.{0,4}(金額|PV)|^(男|女|刷卡|現金|舊會員|\d+(\.\d+)?\s*萬)/i;
  if (pending || quoteWords.test(t)) {
    setProp_('QUOTE_UNTIL', '0');
    return quote_(t.replace(/^(試算|計算|算)\s*/, ''), image);
  }
  // 沒寫說明：先當訂單／明細表試算，看不出品項才改成一般看圖
  if (!t) return quote_('', image, true);
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
    const ans = image_(text, img);
    const short = sendReportTg_(chatId);
    return tgSend_(chatId, short || ans);
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
  const ans = answer_(text.replace(/^\/start\b\s*/, '') || '說明');
  const short = sendReportTg_(chatId);
  tgSend_(chatId, short || ans);
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

// msg：文字，或 { text, buttons: [['按鈕', …], …] }（按鈕按下去會直接送出那段文字）
function tgSend_(chatId, msg) {
  const rich = msg && typeof msg === 'object';
  tgApi_('sendMessage', { chat_id: chatId, text: String(rich ? msg.text : msg).slice(0, 4000),
    reply_markup: rich && msg.buttons
      ? { keyboard: msg.buttons.map(row => row.map(t => ({ text: t }))), one_time_keyboard: true, resize_keyboard: true }
      : { remove_keyboard: true } });
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

function reply_(replyToken, msg, extra) {
  const rich = msg && typeof msg === 'object';
  const m = { type: 'text', text: String(rich ? msg.text : msg).slice(0, 5000) };
  if (rich && msg.buttons) {
    m.quickReply = { items: [].concat.apply([], msg.buttons).slice(0, 13)
      .map(t => ({ type: 'action', action: { type: 'message', label: t.slice(0, 20), text: t } })) };
  }
  lineApi_('reply', { replyToken: replyToken, messages: (extra || []).concat([m]).slice(0, 5) });
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
// SOP 購買建議二：這些品項照「每月固定盒數」算，不看顆數
const FIXED_MONTHLY = { '2711AB': 3, '777Q': 2, '168': 2, '111': 2, '101': 2 };
const MIN_2711AB = 3;                    // SOP：新人必須買滿三盒
// 新入會組合與入會贈送（照彥彬試算系統）：女生、男生、九號三種；舊會員不加
const NEW_MEMBER = {
  '女': { pack: '新入會(草本）女', gifts: [['入*會「 211 」', 2], ['入*會「 707 」', 2]] },
  '男': { pack: '新入會(草本）男', gifts: [['入*會「 211 」', 2], ['入*會「 101 」', 2]] },
  '九號': { pack: '新入會(9號）', gifts: [['入*會「 9號兩組」', 1]] },
};
const CAP_BOXES = 4;                 // 每 3 個月的上限，月數更長就等比放寬

function quote_(text, image, fallbackToChat) {
  if (!prop_('OPENAI_API_KEY')) return '還沒設定 OpenAI 金鑰，請到 Apps Script 的指令碼屬性填入 OPENAI_API_KEY。';
  const prices = prices_();
  const sys = '你是訂單辨識助手，負責把圖片或文字轉成 JSON，不要計算金額。\n'
    + '【情況一：草本產品購買明細表】表上有「一、二、三」（或第一、二、三個月）幾欄，每欄標題有「服用 N 月」，'
    + '也可能在欄位底下用紅筆寫「吃3個月」；沒寫月數就當 1。每列有「編號」（印好的或手寫，例如 211、300、299A、211A、255A、2711AB、777Q、260）、'
    + '「顆數」（每次吃幾顆）、「早／中／晚」打勾。只收「顆數有寫數字」的列；顆數空白的列（例如沒用到的月份裡印好的 211）不要收。'
    + 'times 是該列有幾個時段要吃：表格的早、晚通常是印好的勾，就算 2；中也有勾才算 3。'
    + '整欄都沒寫顆數的月份不要放。最右邊的「保養」欄放進 maintenance。左上角有日期、地點，姓名、介紹人照抄；姓名是購買者的人名，不是產品名稱（例如「火山甘露」是產品），看不清楚就留空。'
    + '手寫的 2 常寫得像 >，例如「>60」是 260、「>55A」是 255A、「>711AB」是 2711AB、「7770」「777Q」是 777Q。'
    + '請由上到下一列一列讀，不要跳列、不要把兩列合併；同一欄裡同一個編號只出現一次。'
    + '編號一定是下面價目表裡有的品項編號（例如 211、211A、255A、260、299A、300），讀出來不在價目表裡時，挑字形最像的那個；真的看不出來就照原樣寫，程式會標成看不清楚請人確認。'
    + '顆數通常是 1～6 的小數字。每欄大約有 13 列，寫到最底下的列（例如 2711AB、295）常被漏掉，一定要看到最後一列。'
    + '請先在 raw 裡依欄位把每一列逐字抄下來（例如「一：>711AB 3 ✓✓」），抄完再整理成 periods。\n'
    + '【情況二：一般訂單或打字清單】直接寫品項和數量（盒）的，放進 items，name 要一字不差照抄價目表品項，數量沒寫就當 1。\n'
    + '對應不到價目表的放進 unknown（照原文）。\n'
    + '表上任何地方（空白處、備註、角落）如果有寫試算條件，也要抄出來：payment 寫「現金」或「刷卡」；target 寫目標，例如「22萬PV」「金額 30萬」；'
    + 'buyMonths 是寫明「買幾個月」的數字；join 是入會方式「女」「男」「九號」「舊會員」；monthsWritten：各欄「服用 N 月」的 N 有手寫填上就是 true。沒寫的一律留空，不要猜。\n'
    + '只輸出 JSON：{"name":"","introducer":"","date":"","payment":"","target":"","buyMonths":"","join":"","monthsWritten":false,"raw":["一：肝 211 3 ✓✓"],'
    + '"periods":[{"label":"第一個月","months":1,"rows":[{"code":"211","perDose":3,"times":2}]}],'
    + '"maintenance":[{"code":"211","perDose":3,"times":2}],'
    + '"items":[{"name":"價目表品項","qty":1}],"unknown":["原文"]}\n\n'
    + '價目表品項：\n' + prices.map(p => p.name).join('\n');
  const user = image
    ? [{ type: 'text', text: text || '請辨識這張訂單／購買明細表' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }]
    : text;
  let parsed;
  try {
    // 看手寫明細表用比較強的模型（指令碼屬性 QUOTE_MODEL 可改），一般聊天仍用 MODEL
    const qModel = prop_('QUOTE_MODEL') || 'gpt-4o';
    parsed = JSON.parse(callOpenAI_(sys, [{ role: 'user', content: user }], true, qModel));
    // 明細表再核對一次：拿第一次的結果對照圖片，補漏掉的列、改錯的編號和顆數（失敗就用第一次的結果）
    if (image && (parsed.periods || []).length && prop_('QUOTE_VERIFY') !== 'off') {
      try {
        const check = JSON.parse(callOpenAI_(sys, [
          { role: 'user', content: user },
          { role: 'assistant', content: JSON.stringify(parsed) },
          { role: 'user', content: '請再仔細對照圖片核對一次上面的結果：每一欄（一、二、三、保養）從第一列看到最後一列，'
            + '漏掉的列補上、編號或顆數讀錯的改正、表上沒有的刪掉，服用月數、姓名、介紹人也再確認。'
            + '特別注意每欄最底下幾列、手寫的 2 寫成 > 的編號、紅筆寫的月數。只輸出修正後完整的 JSON（格式同上）。' },
        ], true, qModel));
        if ((check.periods || []).length) parsed = check;
      } catch (e) { console.error('明細表核對失敗：' + e.message); }
    }
  } catch (err) {
    console.error(err);
    if (fallbackToChat) return chat_(text, image);
    return '抱歉，這次沒辨識成功（' + err.message + '），再傳一次看看。';
  }
  // 手寫編號校正：去掉「肝、心肺」這類字、> 當 2、7770 當 777Q…，對到價目表上的編號
  const fix = fixCode_(prices);
  (parsed.periods || []).concat([{ rows: parsed.maintenance || [] }]).forEach(pd => ((pd && pd.rows) || []).forEach(x => { if (x) x.code = fix(x.code); }));
  // 姓名被讀成產品名稱（例如火山甘露）就清掉，不要印在報表上
  const isProduct = v => { const k = normName_(v || ''); return !!k && (/^\d/.test(k) || !!CODE_ALIAS[k] || prices.some(p => normName_(p.name) === k)); };
  if (isProduct(parsed.name)) parsed.name = '';
  if (isProduct(parsed.introducer)) parsed.introducer = '';
  const hasRows = (parsed.periods || []).some(pd => ((pd && pd.rows) || []).length) || (parsed.items || []).length;
  if (fallbackToChat && !hasRows) return chat_(text, image);
  logChat_('user', (image ? '（傳了一張訂單圖片要試算）' : '試算 ') + (text || ''));
  const opts = quoteOpts_(text);
  // 明細表：四個問題（付款、PV 或金額、買滿幾個月、入會方式）明細表上或說明欄已經寫了就不再問，其餘才問
  if (filledPeriods_(parsed).length) {
    const fromSheet = sheetOpts_(parsed);
    const merged = Object.assign({}, fromSheet.opts, opts);
    return askOrQuote_(prices, { parsed: parsed, opts: merged, sheetSaid: fromSheet.said, ts: Date.now() });
  }
  return finishQuote_(prices, parsed, Object.assign({ card: false }, opts));
}

/* ---- 明細表試算的兩個問題：現金／刷卡、要買多少 ---- */
const QUOTE_STATE_TTL = 30 * 60 * 1000;

function quoteState_() {
  try {
    const st = JSON.parse(prop_('QUOTE_STATE') || 'null');
    return st && Date.now() - st.ts < QUOTE_STATE_TTL ? st : null;
  } catch (e) { return null; }
}
function saveQuoteState_(st) { st.ts = Date.now(); setProp_('QUOTE_STATE', JSON.stringify(st)); }
function clearQuoteState_() { setProp_('QUOTE_STATE', ''); }

function filledPeriods_(parsed) {
  return (parsed.periods || []).filter(pd => ((pd && pd.rows) || []).some(x => Number(String(x && x.perDose).normalize('NFKC')) > 0));
}

// 從一句話讀出試算條件：現金／刷卡、男／女／舊會員、買幾個月、目標 PV 或金額、照明細表
function quoteOpts_(text) {
  const t = String(text || '').normalize('NFKC');
  const o = {};
  if (/刷卡/.test(t)) o.card = true; else if (/現金/.test(t)) o.card = false;
  if (/舊會員|不入會|非新/.test(t)) o.newMember = false;
  if (/[九9]號/.test(t)) o.gender = '九號'; else if (/男/.test(t)) o.gender = '男'; else if (/女/.test(t)) o.gender = '女';
  if (/照(明細)?表|照單/.test(t)) o.months = 'sheet';
  if (/不指定|不用|沒有|都可以|隨便|不限/.test(t)) o.target = { kind: 'none' };
  const CN = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十二': 12 };
  const mm = t.match(/(\d+|十二|[一二兩三四五六七八九十])\s*個?月/);
  if (mm) o.months = Number(mm[1]) || CN[mm[1]];
  const num = (v, w) => Math.round(Number(v) * (w ? 10000 : 1));
  const money = t.match(/(?:金額|NT\$?)\s*(\d+(?:\.\d+)?)\s*(萬)?/i) || t.match(/(\d+(?:\.\d+)?)\s*(萬)?\s*元/);
  const pv = t.match(/(\d+(?:\.\d+)?)\s*(萬)?\s*PV/i) || t.match(/PV\s*(\d+(?:\.\d+)?)\s*(萬)?/i)
    || t.match(/(\d+(?:\.\d+)?)\s*(萬)/) || t.match(/(\d{5,7})()/);
  if (money) o.target = { kind: 'amount', value: num(money[1], money[2]) };
  else if (pv && !mm) o.target = { kind: 'pv', value: num(pv[1], pv[2]) };
  // 只說「照明細表」：數量照明細表、也不追目標
  if (o.months === 'sheet' && !o.target) { o.target = { kind: 'none' }; o.targetImplied = true; }
  return o;
}

// 明細表上手寫的試算條件 → 跟說明欄同樣的格式；said 是要顯示給人看「表上寫了什麼」
function sheetOpts_(parsed) {
  const str = v => String(v == null ? '' : v).normalize('NFKC').trim();
  const pay = str(parsed.payment), tgt = str(parsed.target), bm = str(parsed.buyMonths), join = str(parsed.join);
  const o = {}, said = [];
  if (/刷卡/.test(pay)) { o.card = true; said.push('刷卡'); } else if (/現金/.test(pay)) { o.card = false; said.push('現金'); }
  if (tgt) {
    const t = quoteOpts_(/PV|金額|元|NT/i.test(tgt) ? tgt : tgt + 'PV').target;
    if (t && t.kind !== 'none') { o.target = t; said.push(tgt); }
  }
  const m = Number(bm.replace(/[^\d]/g, ''));
  if (m > 0) { o.months = m; said.push('買 ' + m + ' 個月'); }
  else if (parsed.monthsWritten === true || parsed.monthsWritten === 'true') { o.months = 'sheet'; said.push('月數照表上寫的'); }
  const j = quoteOpts_(join);
  if (j.gender) { o.gender = j.gender; said.push(j.gender === '九號' ? '九號入會' : j.gender + '生入會'); }
  else if (j.newMember === false) { o.newMember = false; said.push('舊會員'); }
  return { opts: o, said: said };
}

// 試算前改正明細表：改／加／刪 編號（可指定第幾個月；顆數、次數可省略）
function sheetEdit_(st, text) {
  const t = String(text || '').normalize('NFKC').trim();
  const m = t.match(/^(?:第?\s*([一二三四五六123456])\s*(?:個月|月|欄)?\s*)?(改|加|刪|删|移除|減掉|去掉)\s*([0-9A-Za-z][0-9A-Za-z()]*)\s*(?:(\d+)\s*顆?)?\s*(?:[x×*]\s*(\d)\s*次?|(\d)\s*次)?$/i);
  if (!m) return false;
  const CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  const filled = filledPeriods_(st.parsed);
  if (!filled.length) return false;
  const idx = m[1] ? (CN[m[1]] || Number(m[1])) - 1 : -1;
  if (idx >= filled.length) return false;
  const targets = idx >= 0 ? [filled[idx]] : filled;
  const code = m[3].toUpperCase(), key = normName_(code);
  const dose = m[4] ? Number(m[4]) : 0, times = Number(m[5] || m[6]) || 0;
  const same = x => normName_(x.code) === key;
  if (/刪|删|移除|減掉|去掉/.test(m[2])) {
    targets.forEach(pd => { pd.rows = pd.rows.filter(x => !same(x)); });
    return true;
  }
  const hits = [];
  if (m[2] === '改') targets.forEach(pd => pd.rows.filter(same).forEach(x => hits.push(x)));
  if (hits.length) {
    hits.forEach(x => { if (dose) x.perDose = dose; if (times) x.times = times; });
  } else {
    (idx >= 0 ? filled[idx] : filled[0]).rows.push({ code: code, perDose: dose || 3, times: times || 2 });
  }
  return true;
}

function askOrQuote_(prices, st) {
  const joinAsked = st.opts.gender || st.opts.newMember === false;
  if (st.opts.card === undefined || !st.opts.target || !st.opts.months || !joinAsked) {
    const intro = [];
    if (!st.asked) {
      const p = st.parsed;
      const known = {};
      prices.forEach(x => { known[normName_(x.name)] = 1; });
      Object.keys(CODE_ALIAS).forEach(k => { known[normName_(k)] = 1; });
      let unsure = 0;
      intro.push('📋 收到' + (p.name ? ' ' + p.name + ' 的' : '') + '明細表，我看到：（括號是每次幾顆 × 一天幾次）');
      filledPeriods_(p).forEach(pd => intro.push('', '【' + (pd.label || '') + '｜服用 ' + (Number(pd.months) || 1) + ' 個月】\n'
        + pd.rows.filter(x => Number(String(x.perDose).normalize('NFKC')) > 0).map(x => {
          const ok = known[normName_(x.code)] || FIXED_MONTHLY[normName_(x.code)];
          if (!ok) unsure++;
          return (ok ? '' : '❓') + x.code + '（' + x.perDose + '×' + (Number(x.times) || 2) + '）';
        }).join('、')));
      if (unsure) intro.push('', '❓ 是看不清楚、價目表沒有的編號，請幫我改正');
      if ((st.sheetSaid || []).length) intro.push('', '📝 表上寫了：' + st.sheetSaid.join('、') + '（這幾題就不再問）');
      intro.push('', '✏️ 有讀錯可以直接打：「改 255A 3顆」「刪 270」「加 260 3顆」「第二個月 加 211 3顆」，改完會再給你看一次', '', '────────', '');
      st.asked = true;
    }
    saveQuoteState_(st);
    if (st.opts.card === undefined) {
      return { text: intro.concat(['1️⃣ 這次是現金還是刷卡？']).join('\n'), buttons: [['💵 現金', '💳 刷卡']] };
    }
    if (!st.opts.target) {
      return { text: intro.concat(['2️⃣ 要買多少 PV 或金額？',
        '可以選下面的按鈕，或直接打：「PV 15萬」「金額 30萬」；沒有目標就選「不指定」']).join('\n'),
        buttons: [['22萬PV', '30萬PV'], ['不指定']] };
    }
    if (!st.opts.months) {
      return { text: intro.concat(['3️⃣ 要買滿幾個月？',
        '可以選下面的按鈕，或直接打「買滿2個月」；照明細表寫的月數就選「照明細表」']).join('\n'),
        buttons: [['買滿1個月', '買滿2個月', '買滿3個月'], ['照明細表']] };
    }
    return { text: intro.concat(['4️⃣ 入會方式？', '男生、女生、九號三種入會組合；已經是會員就選「舊會員」']).join('\n'),
      buttons: [['👩 女生', '👨 男生'], ['9️⃣ 九號', '舊會員']] };
  }
  clearQuoteState_();
  return finishQuote_(prices, st.parsed, st.opts);
}

function finishQuote_(prices, parsed, opts) {
  parsed.card = !!opts.card;
  parsed.newMember = opts.newMember !== false;
  parsed.gender = opts.gender || '';
  const months = Number(opts.months) || 0;
  const target = opts.target && opts.target.kind !== 'none' ? opts.target : null;
  // 先照選的月數取明細表；有 PV／金額目標時一定要買到目標：不夠就把最後一個月份拉長到達標為止
  const base = months ? sliceMonths_(parsed, months) : parsed;
  let result = fitTarget_(prices, base, target ? target.value : 0, target ? target.kind : '');
  if (target && result.isSheet) result = trimToTarget_(prices, base, target, result);
  if (months) result.goalNote = '🗓️ 買滿 ' + months + ' 個月'
    + (result.totalMonths > months ? '還不到目標，已補到 ' + result.totalMonths + ' 個月才達標' : '');
  LAST_QUOTE_ = result.lines.length ? result : null;
  if (result.isSheet) result.byMonths = [1, 2, 3].map(m => byMonths_(prices, parsed, m));
  const answer = quoteText_(result);
  logChat_('assistant', answer);
  return answer;
}

// SOP：現金購買 211 可少算——贈品 211(30)（每瓶 30 顆）和入會送的 211 盒數先扣掉，211 只買不夠的部分。
// 贈品數又看總金額，所以來回算到穩定為止；刷卡沒有贈品，不扣
function applyCash211_(r) {
  if (r.card || !r.isSheet) return r;   // 打字或訂單照原數量，不幫你改
  const l = r.lines.filter(x => normName_(x.name) === '211')[0];
  if (!l || !l.qty) return r;
  const need = l.qty, unitP = l.price / l.qty, unitPv = l.pv / l.qty;
  const joined = r.lines.filter(x => /入.*會/.test(x.name) && /211/.test(x.name)).reduce((a, x) => a + x.qty, 0);
  const others = r.lines.filter(x => x !== l).reduce((a, x) => a + x.price, 0);
  let qty = need, gifts = 0;
  for (let i = 0; i < 10; i++) {
    gifts = Math.floor((others + qty * unitP) / CASH_GIFT_AMOUNT);
    const next = Math.max(0, need - joined - Math.floor(gifts * 30 / 90));
    if (next === qty) break;
    qty = next;
  }
  if (qty === need) return r;
  l.qty = qty; l.price = unitP * qty; l.pv = unitPv * qty;
  if (!qty) r.lines = r.lines.filter(x => x !== l);
  r.notes = (r.notes || []).concat(['現金：211 需要 ' + need + ' 盒，扣掉' + (joined ? '入會送的 ' + joined + ' 盒和' : '')
    + '贈品 211(30) ' + gifts + ' 瓶（' + gifts * 30 + ' 顆），只買 ' + qty + ' 盒']);
  return r;
}

// 只買前 m 個月：照明細表的月份順序取，取到 m 個月為止；表上不夠 m 個月就把最後一段拉長
function byMonths_(prices, parsed, m) {
  const r = applyCash211_(computeQuote_(prices, sliceMonths_(parsed, m)));
  const amount = r.lines.reduce((a, l) => a + l.price, 0);
  return { months: m, amount: amount, pv: r.lines.reduce((a, l) => a + l.pv, 0), gifts: r.card ? 0 : Math.floor(amount / CASH_GIFT_AMOUNT) };
}

function sliceMonths_(parsed, m) {
  const copy = JSON.parse(JSON.stringify(parsed));
  const filled = filledPeriods_(copy);
  let left = m;
  const out = [];
  filled.forEach(pd => {
    if (left <= 0) return;
    const take = Math.min(left, Math.max(1, Number(pd.months) || 1));
    out.push(Object.assign({}, pd, { months: take }));
    left -= take;
  });
  if (left > 0 && out.length) out[out.length - 1].months += left;
  copy.periods = out;
  return copy;
}

// SOP 刪減原則：超過目標時，從第三個月（最後一個月份）的產品開始刪，基本款 211、300、299A 不刪；
// 一項一項試著拿掉，拿掉後仍達標才真的刪，最後留下「剛好達標」的組合
const BASIC_CODES = ['211', '300', '299A'];
function trimToTarget_(prices, base, target, result) {
  const sum = q => q.lines.reduce((a, l) => a + (target.kind === 'amount' ? l.price : l.pv), 0);
  if (sum(result) <= target.value) return result;
  const work = JSON.parse(JSON.stringify(base));
  const calc = () => applyCash211_(computeQuote_(prices, work));
  const removed = [];
  let best = result;
  const filled = filledPeriods_(work);
  for (let pi = filled.length - 1; pi >= 0; pi--) {
    const pd = filled[pi];
    for (let ri = pd.rows.length - 1; ri >= 0; ri--) {
      const row = pd.rows[ri];
      if (BASIC_CODES.indexOf(normName_(row.code)) >= 0 || !(Number(String(row.perDose).normalize('NFKC')) > 0)) continue;
      pd.rows.splice(ri, 1);
      const r = calc();
      if (r.lines.length && sum(r) >= target.value) { best = r; removed.push((pd.label || '') + ' ' + row.code); }
      else pd.rows.splice(ri, 0, row);
    }
  }
  if (!removed.length) return result;
  ['target', 'targetKind', 'fitLabel'].forEach(k => { if (result[k] !== undefined) best[k] = result[k]; });
  best.notes = (best.notes || []).concat(['✂️ 依 SOP 刪減原則（超過目標先刪第三個月、基本款 211／300／299A 不刪），拿掉：' + removed.join('、')]);
  return best;
}

// 有目標 PV 時：把最後一個有寫顆數的月份拉長（一次加 1 個月），直到總 PV 達標；最多 36 個月
function fitTarget_(prices, parsed, target, kind) {
  const calc = () => applyCash211_(computeQuote_(prices, parsed));
  let r = calc();
  if (!target || !r.isSheet) return r;
  const filled = filledPeriods_(parsed);
  const last = filled[filled.length - 1];
  const pvOf = q => q.lines.reduce((a, l) => a + (kind === 'amount' ? l.price : l.pv), 0);
  let m = Math.max(1, Number(last.months) || 1);
  while (pvOf(r) < target && m < 36) {
    last.months = ++m;
    r = calc();
  }
  r.target = target;
  r.targetKind = kind || 'pv';
  r.fitLabel = String(last.label || '');
  return r;
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
    const fixed = FIXED_MONTHLY[normName_(code)];
    return { key: pack ? normName_(code) : p.name, n: fixed ? fixed * months : Math.ceil(pills / (p.perBox || 90)) };
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
  const totalMonths = periods.reduce((a, pd) => a + pd.months, 0);
  const notes = [];
  // 新入會：加入會組合和入會贈送（女：211、707 各 2；男：211、101 各 2；九號：9號兩組 1）
  if (isSheet && parsed.newMember !== false) {
    const g = parsed.gender || '女';
    const join = NEW_MEMBER[g];
    if (find(join.pack)) add(find(join.pack).name, 1);
    join.gifts.forEach(x => { const p = find(x[0]); if (p) add(p.name, x[1]); });
    if (!parsed.gender) notes.push('新入會預設用「女」的組合；男生打「男」、九號打「九號」，舊會員打「舊會員」');
  }
  if (isSheet) {
    const tea = find('火山甘露');
    if (tea && !boxes[tea.name]) add(tea.name, totalMonths);   // SOP：火山甘露一個月一盒
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
    let n = boxes[key];
    const cap = Math.floor(CAP_BOXES * Math.max(3, totalMonths) / 3);
    if (isSheet && CAPPED.indexOf(key) >= 0 && n > cap) {
      warn.push(key + ' 算出 ' + n + ' 盒，依 SOP 上限（每 3 個月 ' + CAP_BOXES + ' 盒）調成 ' + cap + ' 盒');
      n = cap;
    }
    if (isSheet && key === '2711AB' && n < MIN_2711AB) n = MIN_2711AB;
    const pack = PACKS[key];
    if (pack) {
      const sets = Math.min(Math.floor(n / pack.size), pack.maxSets);
      const singles = n - sets * pack.size;
      if (sets) lines.push(line_(byName[normName_(pack.set)], sets, key + ' ' + sets * pack.size + ' 盒'));
      if (singles) lines.push(line_(byName[normName_(pack.single)], singles, key + ' ' + singles + ' 盒'));
    } else {
      lines.push(line_(byName[normName_(key)], n));
    }
  });

  lines.forEach(l => {
    const m = l && String(l.name).normalize('NFKC').match(/限(\d+)/);
    if (m && l.qty > Number(m[1])) warn.push(l.name + ' 限購 ' + m[1] + '，目前 ' + l.qty);
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
    isSheet: isSheet, periods: periods, totalMonths: totalMonths, card: !!parsed.card, lines: lines.filter(Boolean), maint: maint.filter(Boolean),
    unknown: unknown.filter((x, i, a) => a.indexOf(x) === i), warn: warn, notes: notes,
  };
}

function line_(p, qty, label) {
  if (!p) return null;
  return { name: p.name, label: label || p.name, qty: qty, price: p.price * qty, pv: p.pv * qty };
}

// 文字和圖片共用的數字：總金額、PV、贈品、天數、獎金
function reportData_(r) {
  let amount = 0, pv = 0;
  r.lines.forEach(l => { amount += l.price; pv += l.pv; });
  const gifts = r.card ? 0 : Math.floor(amount / CASH_GIFT_AMOUNT);
  const twos = r.lines.filter(l => /^2/.test(l.name)).map(l => l.qty);
  const days = twos.length ? Math.max.apply(null, twos) * DAYS_PER_BOX : 0;
  const newMember = r.lines.some(l => /入會|新會員/.test(l.name));
  const bonus = Object.keys(BONUS_RATES).map(type => {
    const tier = BONUS_RATES[type].filter(t => pv >= t[0])[0];
    if (!tier) return { type: type, tier: null };
    const b = Math.floor(amount * tier[1]);
    return { type: type, tier: tier, pct: Math.round(tier[1] * 100), amount: b, afterTax: Math.floor(b * 0.9), from: tier[0] };
  });
  return { amount: amount, pv: pv, gifts: gifts, days: days, newMember: newMember,
    bonusBlocked: newMember && pv < NEW_MEMBER_PV, bonus: bonus };
}

function quoteText_(r) {
  if (!r.lines.length) {
    return '我沒從裡面找到價目表上的品項' + (r.unknown.length ? '（看到：' + r.unknown.join('、') + '）' : '')
      + '。可以拍清楚一點再傳，或直接打字：試算 211 2盒、777Q 1盒';
  }
  const n = x => Number(x).toLocaleString('en-US');
  const d = reportData_(r);
  const amount = d.amount, pv = d.pv, gifts = d.gifts, days = d.days;

  const out = ['🧾 康園試算報表'];
  const who = [r.name ? '購買者 ' + r.name : '', r.introducer ? '介紹人 ' + r.introducer : '', r.date].filter(Boolean).join('｜');
  if (who) out.push(who);
  out.push((r.card ? '💳 刷卡' : '💵 現金') + (r.isSheet ? '｜服用 ' + r.totalMonths + ' 個月' : '') + (days ? '｜預估可使用 ' + days + ' 天' : ''));
  if (r.target) out.push('🎯 目標' + (r.targetKind === 'amount' ? '金額 NT$ ' + n(r.target) : ' ' + n(r.target) + ' PV') + '：'
    + (r.fitLabel ? r.fitLabel + '的' : '') + '服用月數自動調整到達標為止');
  if (r.goalNote) out.push(r.goalNote);
  if (r.isSheet) {
    out.push('', '【看到的內容】（括號是每次顆數）');
    r.periods.forEach(pd => out.push(pd.label + '（服用 ' + pd.months + ' 個月）：' + pd.rows.join('、')));
  }
  out.push('', '【品項明細】');
  r.lines.forEach(l => {
    out.push((l.label !== l.name ? l.label + '（' + l.name + ' × ' + l.qty + '）' : l.name + ' × ' + l.qty));
    out.push('　金額 ' + n(l.price) + '｜PV ' + n(l.pv));
  });
  if (gifts) out.push(GIFT_NAME + ' × ' + gifts + '（現金每滿 2 萬送 1 瓶）');

  out.push('', '💰 總金額：NT$ ' + n(amount), '🎯 總 PV：' + n(pv));
  TARGETS_PV.forEach(t => out.push('距離 ' + (t / 10000) + ' 萬 PV：' + (pv >= t ? '0 🎉 已達標' : n(t - pv))));

  out.push('', '【預計獎金】（總金額 × 級距 %，扣稅 10%）');
  if (d.bonusBlocked) {
    out.push('新入會需累積滿 2 萬 PV 才開始計算獎金，目前暫無');
  } else {
    d.bonus.forEach(b => out.push(b.tier ? b.type + ' ' + b.pct + '%：約 NT$ ' + n(b.amount) + '，扣稅後約 NT$ ' + n(b.afterTax) : b.type + '：PV 未達最低門檻'));
    if (d.newMember) out.push('（有新入會：總 PV 已滿 2 萬門檻）');
  }

  if (r.byMonths) {
    out.push('', '【買幾個月要多少】');
    r.byMonths.forEach(b => out.push('買 ' + b.months + ' 個月：NT$ ' + n(b.amount) + '｜PV ' + n(b.pv) + (b.gifts ? '｜贈品 ' + b.gifts + ' 瓶' : '')));
  }
  if (r.maint.length) {
    let ma = 0, mp = 0;
    out.push('', '【保養：之後每個月】');
    r.maint.forEach(l => { ma += l.price; mp += l.pv; out.push(l.label + ' → ' + l.name + ' × ' + l.qty); });
    out.push('每月金額：' + n(ma) + ' 元｜PV ' + n(mp) + '（不含在上面的總計）');
  }
  if (r.warn.length || (r.notes || []).length) out.push('');
  (r.notes || []).forEach(w => out.push('💡 ' + w));
  r.warn.forEach(w => out.push('⚠️ ' + w));
  if (r.unknown.length) out.push('', '⚠️ 這些我對不到價目表，沒算進去：' + r.unknown.join('、'));
  out.push('', r.isSheet ? '盒數＝每次顆數 × 時段 × 30 天 × 月數 ÷ 每盒顆數（無條件進位）。字是辨識出來的，請再核對一次。'
    : '數量是辨識出來的，請再核對一次。');
  return out.join('\n');
}

// 全形半形、空白、括號統一，避免「(Ａ)」「（A）」對不上
// 回傳一個把手寫編號校正成價目表編號的函式；對不到就照原樣（摘要會標 ❓）
function fixCode_(prices) {
  const known = {};
  const addKey = k => { if (k) known[k] = k; };
  prices.forEach(p => { const k = normName_(p.name); addKey(k); addKey(k.replace(/[(（].*$/, '')); });
  Object.keys(PACKS).concat(Object.keys(FIXED_MONTHLY)).forEach(addKey);
  Object.keys(CODE_ALIAS).forEach(k => { known[normName_(k)] = CODE_ALIAS[k]; });
  const look = k => known[k] || '';
  return code => {
    const raw = normName_(code);
    if (!raw || look(raw)) return look(raw) || String(code || '');
    // 有數字的才去掉中文說明（「肝211」「消炎211A」）；「火山甘露」這種純文字保留
    let k = /\d/.test(raw) ? raw.replace(/^[^0-9A-Z>＞]+/, '').replace(/[^0-9A-Z>＞]/g, '') : raw;
    k = k.replace(/^[>＞]+/, '2');
    const tries = [k, '2' + k,
      k.replace(/[OD]/g, '0'), k.replace(/Z/g, '2'), k.replace(/S/g, '5'), k.replace(/[IL|]/g, '1'),
      /^777./.test(k) && k.length === 4 ? '777Q' : '',
      /^7?711A[B8]$/.test(k) ? '2711AB' : '',
      k.replace(/8$/, 'B'), k.replace(/^Z/, '2')];
    for (const t of tries) if (t && look(t)) return look(t);
    return k || String(code || '');
  };
}

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

/* ============ 試算報表圖片（Telegram） ============ */
// 用 Google 簡報畫一張「康園試算報表」風格的圖：建立暫時的簡報 → 一次 batchUpdate 畫好 → 取 PNG 縮圖 → 刪掉簡報。
// 圖片直接傳到 Telegram，另外存一份到自己雲端硬碟的「小乖試算報表」資料夾（不公開）。
let LAST_QUOTE_ = null;
const REPORT_FOLDER = '小乖試算報表';
const REPORT_BY = '彥彬｜助理小乖';   // 報表上的「試算者」
const C = {
  bg: '#1c1c1c', card: '#262626', gold: '#d4af37', gold2: '#f0c75e', teal: '#2ee6c5', purple: '#c084fc',
  white: '#ffffff', grey: '#9a9a9a', head: '#2f6fb5', row1: '#ffffff', row2: '#eef1f5', ink: '#222222', qty: '#b07a00', green: '#4ade80',
};

// 第一次使用前在編輯器執行一次，讓 Google 授權「簡報」與「雲端硬碟」權限
function authorizeReport() {
  const id = slidesApi_('post', '', { title: '小乖授權測試' }).presentationId;
  SlidesApp.openById(id);
  DriveApp.getFileById(id).setTrashed(true);
  Logger.log('授權完成，可以產生試算報表圖片了。');
}

function slidesApi_(method, path, body) {
  // 優先用 Apps Script「服務」裡加入的 Google Slides API（不用另外到 Cloud 主控台啟用）
  if (typeof Slides !== 'undefined') {
    // 「The service is currently unavailable」多半是暫時的，最多試 3 次
    for (let i = 0; ; i++) {
      try { return slidesAdv_(path, body); } catch (err) {
        if (i >= 2 || !/unavailable|internal|backend|503|500/i.test(err.message)) throw err;
        Utilities.sleep(1500 * (i + 1));
      }
    }
  }
  const opt = {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  };
  if (body) opt.payload = JSON.stringify(body);
  const res = UrlFetchApp.fetch('https://slides.googleapis.com/v1/presentations' + path, opt);
  if (res.getResponseCode() !== 200) throw new Error('Slides ' + res.getResponseCode() + '：' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

function slidesAdv_(path, body) {
  if (path === '') return Slides.Presentations.create(body);
  let m = path.match(/^\/([^/:]+):batchUpdate$/);
  if (m) return Slides.Presentations.batchUpdate(body, m[1]);
  m = path.match(/^\/([^/]+)\/pages\/([^/?]+)\/thumbnail/);
  if (m) return Slides.Presentations.Pages.getThumbnail(m[1], m[2], { 'thumbnailProperties.mimeType': 'PNG', 'thumbnailProperties.thumbnailSize': 'LARGE' });
  m = path.match(/^\/([^/:?]+)$/);
  if (m) return Slides.Presentations.get(m[1]);
  throw new Error('不支援的 Slides 呼叫：' + path);
}

function rgb_(hex) {
  const h = hex.replace('#', '');
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}

// 組出畫報表的 Slides 請求（拆出來方便測試）；回傳 { W, H, build(slideId) }
function reportLayout_(r) {
  const d = reportData_(r);
  const n = x => Number(x).toLocaleString('en-US');
  const rows = r.lines.map(l => l.price || l.pv
    ? { name: l.name, qty: l.qty, sub: '單價 ' + n(Math.round(l.price / l.qty)) + '｜PV ' + n(Math.round(l.pv / l.qty)), amount: 'NT$ ' + n(l.price), pv: n(l.pv) }
    : { name: l.name, qty: l.qty, sub: '入會贈送', amount: '贈送', pv: '—' });
  if (d.gifts) rows.push({ name: GIFT_NAME, qty: d.gifts, sub: '現金每滿 2 萬送 1 瓶', amount: '贈品', pv: '—', gift: true });
  const boxes = r.lines.reduce((a, l) => a + l.qty, 0);

  const W = 540, X = 20, TW = 500, HEAD = 26, ROW = 38, TOTAL = 32;
  const tableTop = 128;
  const tableH = HEAD + rows.length * ROW + TOTAL;
  let y = tableTop + tableH + 16;
  const sumTop = y; y += 84;
  const tgtTop = y; y += 70;
  const bonusTop = y; const bonusH = d.bonusBlocked ? 50 : 30 + d.bonus.length * 22; y += bonusH + 10;
  const footTop = y; y += 26;

  const build = slide => {
    const req = [];
    req.push({ updatePageProperties: { objectId: slide, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb_(C.bg) } } } }, fields: 'pageBackgroundFill.solidFill.color' } });
    let k = 0;
    const place = (w, h, x, yy) => ({ pageObjectId: slide,
      size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: h, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: yy, unit: 'PT' } });
    const style = (size, color, bold) => ({ fontSize: { magnitude: size, unit: 'PT' }, bold: !!bold, fontFamily: 'Noto Sans TC',
      foregroundColor: { opaqueColor: { rgbColor: rgb_(color) } } });
    const box = (x, yy, w, h, fill, outline) => {
      const id = 'xg_box_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'ROUND_RECTANGLE', elementProperties: place(w, h, x, yy) } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'shapeBackgroundFill.solidFill.color,outline', shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb_(fill) } } },
        outline: { outlineFill: { solidFill: { color: { rgbColor: rgb_(outline) } } }, weight: { magnitude: 1, unit: 'PT' } } } } });
    };
    const text = (str, x, yy, w, h, size, color, bold, align) => {
      const id = 'xg_txt_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: place(w, h, x, yy) } });
      req.push({ insertText: { objectId: id, text: String(str) } });
      req.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'fontSize,bold,foregroundColor,fontFamily', style: style(size, color, bold) } });
      req.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'alignment', style: { alignment: align || 'CENTER' } } });
      req.push({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: 'MIDDLE' }, fields: 'contentAlignment' } });
    };

    // 標題區
    text('『彥彬🌿試算系統』', X, 6, TW, 16, 8, C.grey, false, 'END');
    text('🌿 康園試算報表', X, 20, TW, 34, 22, C.white, true);
    box(X, 58, TW, 32, C.card, C.gold);
    text((r.card ? '💳 刷卡' : '💵 現金') + (d.days ? '　｜　📦 預估可使用天數 ' + d.days + ' 天' : ''), X, 58, TW, 32, 12, C.gold2, true);
    text('購買者：' + (r.name || '—') + '　　試算者：' + REPORT_BY, X, 96, TW, 24, 11, C.white, true);

    // 品項表：用色塊和文字框排，欄位對齊不受表格自動撐高影響
    // 欄位：品項（下方小字：單價｜PV）｜數量｜小計金額｜小計 PV
    // 簡報文字框左右各有約 7pt 內距，數量欄要留寬一點，「× 10」才不會被擠到換行
    const COL = [{ x: 0, w: 186 }, { x: 186, w: 84 }, { x: 270, w: 126 }, { x: 396, w: 104 }];
    const rect = (x, yy, w, h, fill) => {
      const id = 'xg_rect_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'RECTANGLE', elementProperties: place(w, h, x, yy) } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState', shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb_(fill) } } }, outline: { propertyState: 'NOT_RENDERED' } } } });
    };
    const colText = (ci, str, yy, h, size, color, bold, align) =>
      text(str, X + COL[ci].x + (ci === 0 ? 4 : 0), yy, COL[ci].w - (ci === 0 ? 4 : 2), h, size, color, bold, align);
    let ty = tableTop;
    rect(X, ty, TW, HEAD, C.head);
    ['品項名稱', '數量', '小計金額', '小計 PV'].forEach((h, ci) => colText(ci, h, ty, HEAD, 11, C.white, true, ci === 0 ? 'START' : ci === 1 ? 'CENTER' : 'END'));
    ty += HEAD;
    rows.forEach((rw, i) => {
      rect(X, ty, TW, ROW, rw.gift ? '#fff6dc' : i % 2 ? C.row2 : C.row1);
      colText(0, rw.name, ty + 3, 19, 12, C.ink, true, 'START');
      colText(0, rw.sub, ty + 21, 14, 8, '#6b7280', false, 'START');
      colText(1, '× ' + rw.qty, ty, ROW, 13, C.qty, true, 'CENTER');
      colText(2, rw.amount, ty, ROW, 12, C.ink, true, 'END');
      colText(3, rw.pv, ty, ROW, 12, '#0f766e', true, 'END');
      ty += ROW;
    });
    rect(X, ty, TW, TOTAL, '#e3ebf7');
    colText(0, '合計', ty, TOTAL, 12, C.head, true, 'START');
    colText(1, boxes + ' 盒', ty, TOTAL, 11, C.head, true, 'CENTER');
    colText(2, 'NT$ ' + n(d.amount), ty, TOTAL, 12, C.head, true, 'END');
    colText(3, n(d.pv), ty, TOTAL, 12, C.head, true, 'END');
    // 欄位分隔線
    [1, 2, 3].forEach(ci => rect(X + COL[ci].x, tableTop + HEAD, 0.6, tableH - HEAD, '#d5dbe3'));

    // 總金額／總 PV
    const half = (TW - 10) / 2;
    box(X, sumTop, half, 74, C.card, C.gold);
    text('💰 總金額 NT$', X, sumTop + 6, half, 20, 11, C.white, true);
    text(n(d.amount), X, sumTop + 28, half, 40, 24, C.gold2, true);
    box(X + half + 10, sumTop, half, 74, C.card, C.gold);
    text('🎯 總 PV', X + half + 10, sumTop + 6, half, 20, 11, C.white, true);
    text(n(d.pv), X + half + 10, sumTop + 28, half, 40, 24, C.teal, true);

    // 距離 22 萬／30 萬
    box(X, tgtTop, TW, 60, C.card, C.gold);
    TARGETS_PV.forEach((t, i) => {
      const x = X + i * (TW / 2);
      text('距離 ' + (t / 10000) + ' 萬 PV', x, tgtTop + 4, TW / 2, 20, 10, C.white, true);
      text(d.pv >= t ? '0 🎉 已達標' : n(t - d.pv), x, tgtTop + 24, TW / 2, 30, 18, d.pv >= t ? C.green : C.purple, true);
    });

    // 預計獎金
    box(X, bonusTop, TW, bonusH, '#16302a', '#1f7a5c');
    if (d.bonusBlocked) {
      text('🆕 新入會需累積滿 20,000 PV 才開始計算獎金，目前暫無', X, bonusTop + 10, TW, 30, 11, C.white, true);
    } else {
      text('預計獎金（總金額 × 級距 %｜扣稅 10% 後）', X, bonusTop + 4, TW, 22, 10, C.grey, false);
      d.bonus.forEach((b, i) => text(b.tier
        ? (b.type === '經理' ? '🏅 ' : '👤 ') + b.type + ' ' + b.pct + '%：約 NT$ ' + n(b.amount) + '　扣稅後 NT$ ' + n(b.afterTax)
        : b.type + '：PV 未達最低門檻', X, bonusTop + 26 + i * 22, TW, 22, 11, b.type === '經理' ? C.gold2 : C.teal, true));
    }
    text('彥彬｜助理小乖 自動試算｜數量依圖片辨識，請再核對　' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), X, footTop, TW, 20, 8, C.grey);
    return req;
  };
  return { W: W, H: y, build: build };
}

// 把試算畫成 PNG（失敗回 null，原因放在 REPORT_ERR_，不影響文字回覆）
let REPORT_ERR_ = '';
function reportPng_(r) {
  if (!r) return null;
  let pid = null;
  try {
    const L = reportLayout_(r);
    const deck = newDeck_(L.W, L.H);
    pid = deck.pid;
    const page = deck.pres.slides[0];
    // 頁面沒改成直式時：整張報表等比縮小，置中放進預設的橫式頁面
    let built = L.build(page.objectId);
    const ps = deck.pres.pageSize, pt = v => v.unit === 'EMU' ? v.magnitude / 12700 : v.magnitude;
    const pw = pt(ps.width), ph = pt(ps.height);
    if (Math.abs(pw - L.W) > 1 || Math.abs(ph - L.H) > 1) {
      const sc = Math.min(pw / L.W, ph / L.H);
      built = scaleReq_(built, sc, (pw - L.W * sc) / 2, (ph - L.H * sc) / 2);
    }
    const req = (page.pageElements || []).map(e => ({ deleteObject: { objectId: e.objectId } })).concat(built);
    slidesApi_('post', '/' + pid + ':batchUpdate', { requests: req });
    const th = slidesApi_('get', '/' + pid + '/pages/' + page.objectId + '/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE');
    return UrlFetchApp.fetch(th.contentUrl).getBlob()
      .setName('試算報表_' + (r.name || '') + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm') + '.png');
  } catch (err) {
    REPORT_ERR_ = err.message;
    console.error('報表圖片失敗：' + err.message);
    return null;
  } finally {
    if (pid) try { DriveApp.getFileById(pid).setTrashed(true); } catch (e) { console.error(e); }
  }
}

// Slides API 建立簡報時不能指定頁面大小，所以：建立後匯出成 pptx、改掉頁面尺寸、再用 Drive 服務轉回 Google 簡報。
// 沒加入 Drive 服務（或轉檔失敗）就用預設的橫式頁面，報表會縮小置中
function newDeck_(W, H) {
  const created = slidesApi_('post', '', { title: '小乖試算報表' });
  let pid = created.presentationId;
  if (typeof Drive === 'undefined') return { pid: pid, pres: created };
  let newId = null;
  try {
    const pptx = UrlFetchApp.fetch('https://docs.google.com/presentation/d/' + pid + '/export/pptx', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
    const EMU = 12700;
    const files = Utilities.unzip(pptx.setContentType('application/zip')).map(f => f.getName() !== 'ppt/presentation.xml' ? f
      : Utilities.newBlob(f.getDataAsString().replace(/<p:sldSz[^>]*\/>/, '<p:sldSz cx="' + Math.round(W * EMU) + '" cy="' + Math.round(H * EMU) + '"/>'),
        'application/xml', f.getName()));
    const zip = Utilities.zip(files, 'report.pptx').setContentType('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const mime = 'application/vnd.google-apps.presentation';
    const f2 = typeof Drive.Files.create === 'function'
      ? Drive.Files.create({ name: '小乖試算報表', mimeType: mime }, zip)
      : Drive.Files.insert({ title: '小乖試算報表', mimeType: mime }, zip, { convert: true });
    newId = f2.id;
    const pres = slidesApi_('get', '/' + newId);
    try { DriveApp.getFileById(pid).setTrashed(true); } catch (e) { console.error(e); }
    return { pid: newId, pres: pres };
  } catch (err) {
    console.error('報表頁面改尺寸失敗，改用橫式：' + err.message);
    if (newId) try { DriveApp.getFileById(newId).setTrashed(true); } catch (e) { console.error(e); }
    return { pid: pid, pres: created };
  }
}

// 把整組繪圖指令等比縮放（位置、大小、字級、欄寬列高），再平移 ox, oy
function scaleReq_(reqs, sc, ox, oy) {
  const SIZE_KEYS = { width: 1, height: 1, fontSize: 1, columnWidth: 1, minRowHeight: 1 };
  const walk = (o, key) => {
    if (Array.isArray(o)) return o.forEach(v => walk(v, key));
    if (!o || typeof o !== 'object') return;
    if (SIZE_KEYS[key] && typeof o.magnitude === 'number') o.magnitude = Math.round(o.magnitude * sc * 100) / 100;
    if (key === 'transform') { o.translateX = o.translateX * sc + ox; o.translateY = o.translateY * sc + oy; }
    Object.keys(o).forEach(k => walk(o[k], k));
  };
  walk(reqs, '');
  return reqs;
}

// Telegram：有剛算好的試算就先傳圖片，並在自己的雲端硬碟留一份
function sendReportTg_(chatId) {
  const r = LAST_QUOTE_; LAST_QUOTE_ = null;
  if (!r) return null;
  REPORT_ERR_ = '';
  const png = reportPng_(r);
  if (!png) {
    tgSend_(chatId, reportErrText_());
    return null;
  }
  try { saveReport_(png); } catch (e) { console.error(e); }
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/sendPhoto', {
    method: 'post', muteHttpExceptions: true,
    payload: { chat_id: String(chatId), photo: png, caption: '康園試算報表' + (r.name ? '｜' + r.name : '') },
  });
  if (res.getResponseCode() !== 200) {
    console.error('Telegram sendPhoto 失敗：' + res.getContentText());
    tgSend_(chatId, '報表圖片傳送失敗：' + res.getContentText().slice(0, 200));
    return null;
  }
  return shortQuote_(r);
}

// LINE：圖片要公開網址，所以存到雲端硬碟後設成「知道連結的人都能看」（2026-10-14 使用者同意）
function reportLine_() {
  const r = LAST_QUOTE_; LAST_QUOTE_ = null;
  if (!r) return { msgs: [] };
  REPORT_ERR_ = '';
  const png = reportPng_(r);
  try {
    if (!png) throw new Error(REPORT_ERR_);
    const file = saveReport_(png);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const url = 'https://lh3.googleusercontent.com/d/' + file.getId();
    return { msgs: [{ type: 'image', originalContentUrl: url, previewImageUrl: url }], short: shortQuote_(r) };
  } catch (err) {
    REPORT_ERR_ = REPORT_ERR_ || err.message;
    console.error('LINE 報表圖片失敗：' + REPORT_ERR_);
    return { msgs: [{ type: 'text', text: reportErrText_() }] };
  }
}

// 有報表圖片時，文字只留重點（明細都在圖片上）
function shortQuote_(r) {
  const d = reportData_(r);
  return ['🌿 康園試算報表', '',
    '購買者：' + (r.name || '—'),
    '試算者：' + REPORT_BY,
    '預估使用：' + (d.days ? cnMonths_(d.days) : '—'),
    '付款方式：' + (r.card ? '💳 刷卡' : '💵 現金')].join('\n');
}

// 天數換成「五個半月」這種說法（以 30 天為一個月，取到半個月）
function cnMonths_(days) {
  const half = Math.round(days / 15), m = Math.floor(half / 2), h = half % 2;
  const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  if (!m) return h ? '半個月' : days + ' 天';
  return (CN[m] || String(m)) + '個' + (h ? '半' : '') + '月';
}

function saveReport_(png) {
  const it = DriveApp.getFoldersByName(REPORT_FOLDER);
  return (it.hasNext() ? it.next() : DriveApp.createFolder(REPORT_FOLDER)).createFile(png.copyBlob().setName(png.getName()));
}

function reportErrText_() {
  const e = REPORT_ERR_ || '';
  const why = /has not been used|disabled|Slides is not defined/i.test(e)
    ? '還沒加入 Google Slides 服務，請在 Apps Script 左側「服務」按 ＋，選 Google Slides API → 新增，再執行 authorizeReport。'
    : /401|403|scope|permission|權限|授權/i.test(e)
    ? '還沒授權，請在 Apps Script 函式選單選 authorizeReport → 執行 → 允許，再部署新版本。'
    : e.slice(0, 300);
  return '報表圖片沒產生（文字試算如下）。原因：' + why;
}

/* ============ OpenAI ============ */
function callOpenAI_(system, messages, asJson, modelOverride) {
  const model = modelOverride || prop_('MODEL') || 'gpt-4o-mini';
  const body = { model: model, messages: [{ role: 'system', content: system }].concat(messages) };
  if (asJson) body.response_format = { type: 'json_object' };
  if (/^gpt-5/.test(model)) body.max_completion_tokens = 4000;
  else { body.max_tokens = asJson ? 6000 : 2500; body.temperature = asJson ? 0 : 0.6; }   // 辨識明細表要穩定、不能被截斷
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
