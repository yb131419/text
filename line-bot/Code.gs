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
// 快捷按鈕：LINE 是訊息下方的快速回覆，Telegram 是輸入框下方的按鈕
const MENU = [['🐾 對話頁', '📋 試算'], ['🪶 智囊軍師', '⏰ 今天行程'], ['✅ 我的待辦', '📝 我的筆記'], ['📁 本機找', '🌐 上網找'], ['🗂️ 案例分類', '⚙️ 設定'], ['❓ 說明']];
// 快速回覆只留最常用的 5 個，其他收進「💎 選單」精品卡片（LINE 輪播卡片；Telegram／對話頁用分組按鈕）
const MENU_BTN = '💎 選單';
const REELS_BTN = '🎬 剪 Reels';
const REELS_LONG_BTN = '🎞️ 剪大片';
const QUICK = [['🐾 對話頁', MENU_BTN, '📋 試算'], ['🪶 智囊軍師', '✅ 我的待辦']];
const WALL_BTN = '🔎 見證庫';   // 見證庫網頁按鈕（LINE／Telegram 直接打開網頁）
const MENU_CARDS = [
  { en: 'XIAOGUAI', title: '小乖', sub: '你的專屬特助，語音對話、使用說明', items: [['🐾 對話頁', '語音・選照片'], ['❓ 說明', '使用方式']] },
  { en: 'CONCIERGE', title: '軍師與設定', sub: '經營文案與個人化設定', items: [['🪶 智囊軍師', '經營文案'], ['📕 7張＋PDF', '輪播圖卡＋PDF'], ['⚙️ 設定', '署名・標題']] },
  { en: 'VIDEO', title: '影片剪輯', sub: '傳影片給小乖，自動剪接、上字幕、動畫、配樂', items: [[REELS_BTN, '直式短影音'], [REELS_LONG_BTN, '完整長片']] },
  { en: 'TESTIMONY', title: '見證分享', sub: '好見證整理好，隨時轉傳分享', items: [['💬 見證案例', '看見證・轉傳'], ['➕ 新增見證', '圖片影片文字'], ['🔍 查詢案例', '關鍵字找見證'], ['🗂️ 案例分類', '全部分類'], [WALL_BTN, '網頁找・一鍵分享']] },
  { en: 'BUSINESS', title: '業務試算', sub: '明細表一傳，金額與 PV 立刻算好', items: [['📋 試算', '傳明細表照片']] },
  { en: 'SCHEDULE', title: '每日行程', sub: '今天做什麼、接下來排什麼，一目了然', items: [['⏰ 今天行程', '今日安排'], ['➕ 新增行程', '點日期、時間就排好'], ['📅 近期行程', '接下來兩週照時間排'], ['🗑️ 刪除行程', '點一下就刪']] },
  { en: 'NOTES', title: '我的筆記', sub: '靈感、重點、待辦，隨手記、隨時看', items: [['📝 我的筆記', '全部筆記'], ['✍️ 新增筆記', '打一句就存'], ['✅ 我的待辦', '未完成事項']] },
  { en: 'SEARCH', title: '資料搜尋', sub: '本機、網路，一找就到', items: [['📁 本機找', '存過的資料'], ['🌐 上網找', '即時搜尋']] },
];
const MENU_GROUPS = MENU_CARDS.map(c => c.items.map(i => i[0]));
// 回覆按鈕裡的整組常用選單換成精簡的 5 個（試算問題等專屬按鈕照留）
function quick_(b) {
  if (!b || b === QUICK) return b;
  if (b === MENU) return QUICK;
  const rest = b.filter(r => MENU.indexOf(r) < 0);
  return rest.length === b.length ? b : rest.concat(QUICK);
}
function menuCard_() {
  const text = '💎 小乖功能選單\n' + MENU_CARDS.map(c => '\n【' + c.title + '】\n' + c.items.map(i => i[0] + '　' + i[1]).join('\n')).join('\n');
  return { text: text, buttons: MENU_GROUPS, flex: menuFlex_() };
}
// 象牙白＋香檳金精品風輪播卡片：每類一張，按一下就送出那個功能
function menuFlex_() {
  const GOLD = '#B08D57', INK = '#2A2118', SOFT = '#9A8B74', LINE = '#E8DCC4';
  const act = t => t === TALK_BTN
    ? { type: 'uri', label: '對話頁', uri: talkUrl_() + (talkUrl_().indexOf('?') >= 0 ? '&' : '?') + 'openExternalBrowser=1' }
    : t === WALL_BTN ? { type: 'uri', label: '見證庫', uri: wallUrl_() }
    : { type: 'message', label: t.slice(0, 20), text: t };
  const name = t => t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const row = (it, first) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', paddingAll: '13px', cornerRadius: '12px',
    borderWidth: '1px', borderColor: first ? '#C9A56A' : LINE,
    background: first ? { type: 'linearGradient', angle: '120deg', startColor: '#E9D3A2', endColor: '#C9A56A' } : undefined,
    backgroundColor: first ? '#D9BC85' : '#FFFFFF',
    action: act(it[0]), contents: [
      { type: 'text', text: name(it[0]), size: 'sm', weight: 'bold', color: INK, flex: 0 },
      { type: 'text', text: it[1], size: 'xxs', color: first ? '#5A4630' : SOFT, align: 'end', flex: 1, margin: 'md' },
      { type: 'text', text: '›', size: 'md', weight: 'bold', color: first ? INK : GOLD, flex: 0, margin: 'md' },
    ] });
  return { type: 'carousel', contents: MENU_CARDS.map((c, i) => ({
    type: 'bubble', size: 'kilo',
    styles: { body: { backgroundColor: '#FBF8F2' } },
    body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [
      { type: 'box', layout: 'vertical', paddingAll: '22px', paddingBottom: '18px',
        background: { type: 'linearGradient', angle: '180deg', startColor: '#F4EAD6', endColor: '#FBF8F2' }, contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '小乖 · PRIVATE', size: 'xxs', weight: 'bold', color: GOLD, flex: 1 },
          { type: 'text', text: '0' + (i + 1) + ' / 0' + MENU_CARDS.length, size: 'xxs', color: '#B5A88F', align: 'end', flex: 0 },
        ] },
        { type: 'text', text: c.en.split('').join(' '), size: 'xxs', color: SOFT, margin: 'xxl' },
        { type: 'text', text: c.title, size: 'xxl', weight: 'bold', color: INK, margin: 'sm' },
        { type: 'box', layout: 'vertical', width: '28px', height: '2px', backgroundColor: '#C9A56A', margin: 'md', contents: [{ type: 'filler' }] },
        { type: 'text', text: c.sub, size: 'xs', color: '#7D6F5B', wrap: true, margin: 'md' },
      ] },
      { type: 'box', layout: 'vertical', spacing: 'sm', paddingStart: '22px', paddingEnd: '22px', contents: c.items.map((it, k) => row(it, k === 0)) },
      { type: 'filler' },
      { type: 'text', text: '彥彬｜特助小乖', size: 'xxs', color: '#B5A88F', align: 'center', margin: 'xl' },
      { type: 'box', layout: 'vertical', height: '18px', contents: [{ type: 'filler' }] },
    ] },
  })) };
}

const HELP_TEXT = [
  '小乖可以幫你 👇（按「💎 選單」看全部卡片）',
  '',
  '🪶 軍師：選主題，寫文案＋3 張圖卡',
  '💬 見證：按「新增見證」再傳圖片影片，之後查詢、轉傳分享',
  '📋 試算：先按「試算」再傳明細表照片',
  '🎬 Reels：在 Telegram 傳影片，自動剪輯、字幕、動畫字卡、配樂，回覆就能改',
  '📅 行程：新增、今天、這週、刪除',
  '📝 筆記：新增筆記、看筆記和待辦',
  '📁 搜尋：本機找、上網找',
  '🎤 語音：傳語音給小乖，小乖用語音回',
  '',
  '也可以直接說：「明天3點提醒我開會」',
].join('\n');
const HELP_MORE = [
  '📖 更多用法',
  '',
  '【🪶 軍師與設定】',
  '・按「🪶 智囊軍師」選主題：軍師判定、觀念、健康、火山草本、經營、網路行銷',
  '・文案會畫成 3 張圖卡（不同切角）一起給你，長按圖片可以存；「🔁 再寫一篇」同主題換一篇',
  '・按「⚙️ 設定」看、改圖卡署名、文案標題和「新增見證」的說明（打「預設」改回原本的）',
  '',
  '【💬 見證分享】',
  '・按「➕ 新增見證」後 10 分鐘內傳的圖片、影片都存成見證（LINE、Telegram 都可以），傳完按「✅ 存好了」',
  '・Telegram 轉傳時說明打「#見證案例」也可以；LINE 傳影片一律存進案例庫',
  '・LINE、Telegram 存的見證兩邊都看得到、都能轉傳',
  '・按「💬 見證案例」看見證：圖片影片會直接傳出來，長按就能轉傳',
  '・改說明：存好時或見證卡片上按「✏️ 改說明」，再打新的說明（打「取消」不改）',
  '・查詢：按「🔍 查詢案例」再打關鍵字（產品、人名、說明都可以），也能直接打「查詢案例 王太太」',
  '・刪除：存好時或見證卡片上按「🗑️ 刪除」，再按「確定刪除」才會刪',
  '・案例分類：看每類有幾筆；改分類 名稱：改剛存那筆的分類',
  '・新增分類／分類改名 舊 新／刪除分類',
  '',
  '【🎬 剪 Reels】',
  '・在 Telegram 按「🎬 剪 Reels」再傳影片，或傳影片時說明寫「剪 Reels」',
  '・自動挑精華、剪掉停頓，剪成直式 9:16、上中英短句字幕、開頭動畫字卡、配背景音樂，大約 3～6 分鐘傳回來，還附貼文文案',
  '・要改哪裡：長按小乖傳回的影片按「回覆」直接說（例如：字幕大一點、標題久一點、剪成 30 秒），就會再剪一版',
  '・學風格：傳一張喜歡的影片截圖，說明寫「風格」，之後都照那個字幕樣子剪；打「Reels 風格預設」換回原本的',
  '・說明可以加：「30秒」「標題：邀約三招」「只要中文字幕」「不要字幕」「不要配樂」「清新／溫暖／沉穩」（配樂風格）',
  '・影片要在 20MB 以內（Telegram 傳影片時選壓縮就好）',
  '',
  '【📋 試算】',
  '・先按「📋 試算」再傳明細表 → 回答 4 題就出報表',
  '・LINE 沒按試算就傳圖片，小乖會問要「試算這張／存成見證／看圖說明」',
  '・讀錯可打：改 255A 3顆／刪 270／加 260 3顆',
  '・打「取消」停止試算',
  '',
  '【📅 行程】',
  '・按「➕ 新增行程」→ 點日期 → 點時間 → 點或打要做的事，不用打字也能排好',
  '・今天行程、近期行程：照日期時間排好，已經過了的不顯示',
  '・按「🗑️ 刪除行程」點一筆就刪，刪錯可以按「↩️ 復原」；也可以說「刪除 名稱」',
  '・過了日期的行程會自動刪掉',
  '',
  '【📝 筆記與待辦】',
  '・按「✍️ 新增筆記」再打內容就存好',
  '・行程有固定時間；待辦是沒有時間、做完才算的事',
  '・說「完成 名稱」「刪除 名稱」整理待辦和筆記',
  '',
  '【📁 資料搜尋】',
  '・本機找 關鍵字：找案例庫、待辦、筆記',
  '・上網找 關鍵字：上網找資料（按按鈕後也可以傳語音）',
  '',
  '【🎤 語音對話】',
  '・傳語音給小乖，小乖也用語音回你',
  '・語音回覆 開：打字也用語音回；語音回覆 關：只回文字',
  '',
  '【👥 群組】',
  '・邀請小乖：10 分鐘內由你邀進群組；群組裡開頭打「小乖」才會回',
  '・小乖離開：退出群組；群組關：離開全部群組',
  '',
  '【其他】',
  '・清除對話：忘掉聊天內容（資料不刪）',
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
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.state && (p.code || p.error) && prop_('TK_STATE')) return tkCallback_(p);   // TikTok 登入回來
  // 「嘿 Siri，小乖」：iPhone 捷徑把聽到的話用 ?key=同步密碼&ask=… 傳進來，小乖回一段可以直接念出來的文字
  if (p.ask !== undefined) {
    if (!prop_('SYNC_KEY') || p.key !== prop_('SYNC_KEY')) return ContentService.createTextOutput('同步密碼不對，請檢查捷徑裡的網址。');
    return ContentService.createTextOutput(askByVoice_(String(p.ask)));
  }
  // 「小乖對話」頁面：手機打開 Webhook 網址再加 &page=talk，加到主畫面就像 App
  if (p.page === 'talk') {
    // 網址可以不帶密碼：頁面第一次會請你輸入，記在這支手機上
    const k = p.key && p.key === prop_('SYNC_KEY') ? p.key : '';
    return HtmlService.createHtmlOutput(TALK_HTML.replace('__KEY__', JSON.stringify(k)))
      .setTitle('小乖').addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setFaviconUrl('https://fonts.gstatic.com/s/e/notoemoji/latest/1f43e/512.png');
  }
  return ContentService.createTextOutput('小乖雲端服務運作中');
}

// 對話頁網址：小乖網址放在 ?u= 裡，第一次打開會自動填好，只要輸入同步密碼（密碼不放網址）
let TALK_URL_ = null;
function talkUrl_() {
  if (TALK_URL_ !== null) return TALK_URL_;
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { console.error(e); }
  TALK_URL_ = TALK_PAGE + (url ? '?u=' + encodeURIComponent(url) : '');
  return TALK_URL_;
}

function talkLink_() {
  return '🐾 小乖對話頁：\n' + talkUrl_()
    + '\n\n第一次打開只要輸入同步密碼（會藏起來、記在手機上）。在 Safari 按「分享 → 加入主畫面」，桌面就有小乖。';
}

// 「🐾 對話頁」按鈕直接打開網頁：LINE 用網址按鈕（開到 Safari，麥克風才能用），Telegram 用 Web App 按鈕
const TALK_BTN = '🐾 對話頁';
function lineQuick_(t) {
  if (t === PHOTO_BTNS[0]) return { type: 'action', action: { type: 'cameraRoll', label: t } };
  if (t === PHOTO_BTNS[1]) return { type: 'action', action: { type: 'camera', label: t } };
  if (t === TALK_BTN) return { type: 'action', action: { type: 'uri', label: t, uri: talkUrl_() + (talkUrl_().indexOf('?') >= 0 ? '&' : '?') + 'openExternalBrowser=1' } };
  if (t === WALL_BTN) return { type: 'action', action: { type: 'uri', label: t, uri: wallUrl_() } };
  return { type: 'action', action: { type: 'message', label: t.slice(0, 20), text: t } };
}
// 試算要照片時給的按鈕：LINE 直接打開相簿／相機，對話頁打開選照片；Telegram 沒有這種按鈕，改成文字提示
const PHOTO_BTNS = ['📷 選照片', '📸 拍照'];
function tgKey_(t) { return t === TALK_BTN ? { text: t, web_app: { url: talkUrl_() } } : t === WALL_BTN ? { text: t, web_app: { url: wallUrl_().replace(/[?&]openExternalBrowser=1$/, '') } } : { text: t }; }
// 「🔎 見證庫」網頁（Cases.html）：跟對話頁一樣把小乖網址放 ?u=，密碼不放網址
const WALL_PAGE = 'https://yb131419.github.io/Tezhu/Cases.html';
function wallUrl_() { const t = talkUrl_(), i = t.indexOf('?'); return WALL_PAGE + (i >= 0 ? t.slice(i) + '&' : '?') + 'openExternalBrowser=1'; }
function wallLink_() { return '🔎 見證庫網頁：\n' + wallUrl_() + '\n\n① 打關鍵字或點分類找見證\n② 點縮圖看影片／圖片\n③ 按「分享到 LINE」選要傳給誰\n\n常用的按 ⭐ 會排在最前面。第一次打開要輸入同步密碼。'; }

// 「小乖對話」頁面用 google.script.run 呼叫這個（名字不能加底線，頁面才叫得到）；回 { say: 念的, show: 畫面顯示的 }
function talk(key, q, image, voice, audio64, audioType) {
  if (!prop_('SYNC_KEY') || key !== prop_('SYNC_KEY')) return { say: '同步密碼不對。', show: '同步密碼不對。' };
  ASK_SHOW_ = ''; ASK_BTNS_ = []; ASK_IMG_ = ''; ASK_IMGS_ = []; TALK_CASES_ = []; TALK_MODE_ = true;
  let heard = '';
  if (audio64) {   // 對話頁按麥克風錄的音：先轉文字
    const mt = String(audioType || 'audio/mp4');
    try {
      heard = transcribe_(Utilities.newBlob(Utilities.base64Decode(String(audio64)), mt, 'voice.' + (/webm/.test(mt) ? 'webm' : /ogg/.test(mt) ? 'ogg' : 'm4a')), 'voice.' + (/webm/.test(mt) ? 'webm' : /ogg/.test(mt) ? 'ogg' : 'm4a'));
    } catch (e) { console.error(e.message); }
    if (!heard) return { say: '沒聽清楚，再說一次看看。', show: '沒聽清楚，再說一次看看。', buttons: [], audio: '', heard: '' };
    q = heard;
  }
  const say = askByVoice_(String(q || ''), image || '');
  let audio = '';
  if (voice && say && prop_('OPENAI_API_KEY')) {   // 用跟 LINE／Telegram 一樣的小乖聲音念
    try { audio = Utilities.base64Encode(tts_(say, 'mp3').getBytes()); } catch (e) { console.error(e.message); }
  }
  return { say: say, show: String(ASK_SHOW_ || say).replace(/\*\*/g, ''), buttons: ASK_BTNS_, audio: audio, heard: heard, img: ASK_IMG_, imgs: ASK_IMGS_, cases: TALK_CASES_ };
}
let ASK_SHOW_ = '', ASK_BTNS_ = [], ASK_IMG_ = '', ASK_IMGS_ = [], TALK_MODE_ = false, VOICE_ONLY_ = false;
const TALK_PAGE = 'https://yb131419.github.io/Tezhu/Talk.html';
// 回覆帶的按鈕（例如試算問「現金／刷卡」）給對話頁當快速回覆；一般選單就不用
function askButtons_(ans) {
  const b = quick_(ans && typeof ans === 'object' && ans.buttons);
  ASK_BTNS_ = b && b !== QUICK ? [].concat.apply([], b).filter(t => t !== '🐾 對話頁').slice(0, 16) : [];
}

function askByVoice_(q, image) {
  q = q.trim();
  if (image) return askPhoto_(q, image);
  if (!q) return '我在，請說。';
  if (/^(沒事了?|沒有了?|結束|掰掰|再見|不用了?|謝謝)[。！!]?$/.test(q)) return '好，有事再叫我。';
  CURRENT_TG_CHAT_ = ''; LINE_MODE_ = false;
  VOICE_ONLY_ = !TALK_MODE_;
  let ans;
  try { ans = answer_(q); } catch (err) { console.error(err); return '小乖現在有點問題，等一下再試試看。'; }
  ASK_SHOW_ = String(ans && typeof ans === 'object' ? ans.text : ans || '');
  askButtons_(ans);
  const tg = prop_('TG_OWNER_CHAT_ID');
  if (LAST_QUOTE_ && tg) {   // 回答完試算問題就出報表：圖片傳到 Telegram
    const short = sendReportTg_(tg);
    tgSend_(tg, short || ans);
    return '試算好了，報表已經傳到 Telegram。';
  }
  LAST_QUOTE_ = null;
  if (KIT_PENDING_) {   // 7張＋PDF：對話頁直接等做好；捷徑就傳到 Telegram
    if (TALK_MODE_) {
      const fail = kitRun_(() => { try { ASK_IMG_ = kitTalk_(); } catch (e) { console.error(e); } });
      if (fail) { ASK_SHOW_ = String(fail.text || fail); return ASK_SHOW_; }
      return '7 張圖卡和 PDF 做好了，在畫面上。';
    }
    if (tg) { const fail = kitRun_(() => kitTg_(tg)); return fail ? String(fail.text || fail) : '7 張圖卡和 PDF 做好了，已經傳到 Telegram。'; }
    KIT_PENDING_ = ''; busyEnd_('KIT_BUSY');
    return '7張＋PDF 要在 LINE、Telegram 或對話頁按按鈕做喔。';
  }
  if (LAST_CARD_) {   // 智囊軍師：對話頁直接顯示圖卡；捷徑（嘿 小乖）就傳到 Telegram
    if (TALK_MODE_) { try { ASK_IMG_ = cardData_(); } catch (e) { console.error(e); ASK_IMG_ = ''; } return '文案和圖卡寫好了，在畫面上，長按圖卡可以存。'; }
    if (tg) { sendCardTg_(tg); tgSend_(tg, ans); return '文案和圖卡寫好了，已經傳到 Telegram。'; }
    LAST_CARD_ = null;
  }
  return speechText_(ans) || '好的。';
}

// 捷徑從手機相簿選照片傳來（base64）：明細表就試算，報表傳到 Telegram；其他照片就看圖回答
function askPhoto_(q, b64) {
  CURRENT_TG_CHAT_ = '';
  const raw = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (raw.length < 100) return '照片沒有收到，再試一次看看。';
  if (raw.length > 14e6) return '照片太大了，換一張小一點的再傳。';
  const img = 'data:image/jpeg;base64,' + raw;
  const before = prop_('QUOTE_STATE');
  let ans;
  try { ans = image_(q, img); } catch (err) { console.error(err); return '照片讀取失敗，等一下再試試看。'; }
  ASK_SHOW_ = String(ans && typeof ans === 'object' ? ans.text : ans || '');
  askButtons_(ans);
  const tg = prop_('TG_OWNER_CHAT_ID');
  if (LAST_QUOTE_) {
    if (tg) {
      const short = sendReportTg_(tg);
      tgSend_(tg, short || ans);
      return '試算好了，報表和明細已經傳到 Telegram。';
    }
    LAST_QUOTE_ = null;
  }
  // 試算的問題（現金還是刷卡…）傳到 Telegram 用按鈕回答，手機只回一句短的（使用者不要一直念）
  if (tg && prop_('QUOTE_STATE') && prop_('QUOTE_STATE') !== before) {
    tgSend_(tg, ans);
    return '收到明細表，問題傳到 Telegram 了，按按鈕回答就好。';
  }
  return speechText_(ans) || '好的。';
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

  // 前端「小乖對話」網頁（Talk.html）：回 JSON { say, show, buttons }
  if (body.action === 'talk') {   // 出錯也要回 JSON，對話頁才看得到原因（不然只會顯示「連線有問題」）
    try { return json_(talk(String(body.key || ''), body.ask, body.image, body.voice, body.audio, body.audioType)); }
    catch (err) { console.error(err); const m = '小乖出了點問題：' + (err && err.message || err); return json_({ say: m, show: m, buttons: [], audio: '', heard: '', img: '' }); }
  }

  // 「嘿小乖」捷徑傳照片（POST JSON：{ action:'ask', key, ask, image: base64 }）
  if (body.action === 'ask') {
    if (!prop_('SYNC_KEY') || body.key !== prop_('SYNC_KEY')) return text_('同步密碼不對，請檢查捷徑裡的設定。');
    return text_(askByVoice_(String(body.ask || ''), body.image || ''));
  }

  // 「嘿 小乖 寫文案」捷徑：POST JSON { action:'card', key, ask:'火山草本' } → { text: 可直接貼的文案, img: 圖卡 PNG 的 base64 }
  if (body.action === 'card') {
    if (!prop_('SYNC_KEY') || body.key !== prop_('SYNC_KEY')) return json_({ ok: false, text: '同步密碼不對，請檢查捷徑裡的 key。', img: '' });
    return json_(cardApi_(String(body.ask || '')));
  }

  // 見證庫網頁（Cases.html）：列案例、⭐ 常用、取分享連結
  if (['cases', 'caseStar', 'caseLink', 'caseDel'].indexOf(body.action) >= 0) {
    if (!prop_('SYNC_KEY') || body.key !== prop_('SYNC_KEY')) return json_({ ok: false, error: '同步密碼不對' });
    try { return json_(wallApi_(body)); } catch (err) { console.error(err); return json_({ ok: false, error: String(err && err.message || err) }); }
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

/* ============ LINE 群組 ============ */
// 只有主人能把小乖邀進群組：主人先私訊「邀請小乖」開 10 分鐘的邀請時間，而且主人本人要在那個群組裡；
// 其他人邀請（或超過時間）小乖一進群組就馬上退出。LINE 不會告訴我們是誰邀的，所以用這兩個條件確認
const INVITE_MINUTES = 10;
function inviteOpen_() { return Number(prop_('GROUP_INVITE_UNTIL')) > Date.now(); }
function lineGroups_() { try { return JSON.parse(prop_('LINE_GROUPS') || '{}'); } catch (e) { return {}; } }
function saveLineGroups_(g) { setProp_('LINE_GROUPS', JSON.stringify(g)); }

function groupSwitch_(cmd) {
  if (/開/.test(cmd)) {
    setProp_('GROUP_INVITE_UNTIL', String(Date.now() + INVITE_MINUTES * 60 * 1000));
    return '✅ 接下來 ' + INVITE_MINUTES + ' 分鐘內，請你自己把小乖邀進群組（你本人要在群組裡）。\n別人邀請小乖，小乖會馬上退出。\n在群組裡，訊息開頭打「小乖」小乖才會回，而且只回你；打「小乖離開」小乖就退出。';
  }
  if (/關/.test(cmd)) {
    setProp_('GROUP_INVITE_UNTIL', '0');
    const groups = lineGroups_();
    Object.keys(groups).forEach(id => leaveLineGroup_(id, groups[id]));
    saveLineGroups_({});
    const n = Object.keys(groups).length;
    return '⛔ 已關閉' + (n ? '，小乖已經離開目前的 ' + n + ' 個群組。' : '，小乖現在不在任何群組。') + '\n之後要再加入，私訊「邀請小乖」。';
  }
  const n = Object.keys(lineGroups_()).length;
  return '小乖目前在 ' + n + ' 個群組。\n要邀小乖進新群組：先私訊「邀請小乖」，再由你在 ' + INVITE_MINUTES + ' 分鐘內邀請。\n要小乖離開全部群組：「群組關」。';
}

// 主人本人在不在這個群組（LINE 查得到群組成員的個人資料就代表在）
function ownerInGroup_(gid, type) {
  const owner = prop_('OWNER_USER_ID');
  if (!owner) return false;
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + (type === 'room' ? 'room' : 'group') + '/' + gid + '/member/' + owner, {
    muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
  });
  return res.getResponseCode() === 200;
}

function leaveLineGroup_(id, type) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + (type === 'room' ? 'room' : 'group') + '/' + id + '/leave', {
    method: 'post', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
  });
  if (res.getResponseCode() !== 200) console.error('LINE 離開群組失敗：' + res.getContentText());
}

function handleLineGroup_(ev, gid, type) {
  const groups = lineGroups_();
  if (ev.type === 'leave') { delete groups[gid]; saveLineGroups_(groups); return; }
  if (ev.type === 'join') {
    if (!inviteOpen_() || !ownerInGroup_(gid, type)) {
      leaveLineGroup_(gid, type);
      return;
    }
    setProp_('GROUP_INVITE_UNTIL', '0');   // 一次邀請只用一次
    groups[gid] = type; saveLineGroups_(groups);
    reply_(ev.replyToken, '大家好，我是小乖 🙋‍♀️\n我只回主人的訊息：訊息開頭打「小乖」我才會回；主人打「小乖離開」我就退出群組。');
    return;
  }
  if (ev.type !== 'message' || !ev.replyToken) return;
  const uid = ev.source.userId, owner = prop_('OWNER_USER_ID');
  // 不是主人邀進來的群組（例如舊版時加入的）：一有訊息就離開
  if (!groups[gid]) { leaveLineGroup_(gid, type); return; }
  if (!owner || uid !== owner) return;   // 群組裡別人的訊息一律不回
  if (ev.message.type === 'image') {
    // 群組裡的圖片：主人先打「小乖 試算」才會讀，免得把大家聊天的照片都拿去算
    if (Number(prop_('QUOTE_UNTIL')) > Date.now()) {
      const ans = image_('試算', lineImage_(ev.message.id)); const rp = reportLine_(); reply_(ev.replyToken, rp.short || ans, rp.msgs);
    }
    return;
  }
  if (ev.message.type !== 'text') return;
  const raw = ev.message.text.trim();
  if (/^小乖\s*(離開|退出|掰掰|bye)/i.test(raw)) {
    reply_(ev.replyToken, '好的，小乖先離開群組，掰掰 👋');
    leaveLineGroup_(gid, type); delete groups[gid]; saveLineGroups_(groups);
    return;
  }
  const called = /^小乖[\s,，:：]*/.test(raw);
  const text = raw.replace(/^小乖[\s,，:：]*/, '');
  // 試算進行中，主人回答問題（現金、22萬…）不用再打「小乖」
  const st = quoteState_();
  const answering = st && !called && text.length <= 15 && (/^(取消|改|加|刪|删)/.test(text) || Object.keys(quoteOpts_(text)).length);
  if (!called && !answering) return;
  if (!text) return reply_(ev.replyToken, '主人叫我嗎？在「小乖」後面接著打要我做的事喔。');
  const ans = answer_(text);
  const rp = reportLine_();
  reply_(ev.replyToken, rp.short || ans, rp.msgs);
}

/* ============ LINE ============ */
function handleLine_(ev) {
  CURRENT_TG_CHAT_ = '';   // LINE 傳不了 Telegram 的檔案，案例圖片只列出數量
  LINE_MODE_ = true;       // 案例用卡片輪播顯示
  const src = ev.source || {};
  if (src.type === 'group' || src.type === 'room') return handleLineGroup_(ev, src.groupId || src.roomId, src.type);
  const uid = ev.source && ev.source.userId;
  const owner = prop_('OWNER_USER_ID');
  if (ev.type === 'follow') {
    if (!owner) reply_(ev.replyToken, '嗨，我是小乖！請傳「綁定 你的同步密碼」完成綁定，之後就能在這裡跟我聊天。');
    return;
  }
  if (ev.type !== 'message' || !ev.replyToken) return;
  if (ev.message.type === 'image' || ev.message.type === 'video') {
    if (!owner || uid !== owner) return;
    // 按了「➕ 新增見證」：圖片、影片存進案例庫；影片一律當案例存
    if (ev.message.type === 'video' || casePending_()) {
      let res;
      try { res = saveLineCase_(ev.message.id, ev.message.type); } catch (err) { console.error(err); res = '存檔失敗：' + err.message; }
      return reply_(ev.replyToken, res, null, true);
    }
    // 先按「📋 試算」再傳圖片才試算；沒按就先問這張要做什麼（圖片記著，按按鈕再處理）
    if (!(Number(prop_('QUOTE_UNTIL')) > Date.now())) {
      setProp_('LINE_LAST_IMG', ev.message.id + '|' + Date.now());
      return reply_(ev.replyToken, { text: '📷 收到圖片，要做什麼？\n（要試算也可以先按「📋 試算」再傳圖片）', buttons: LINE_IMG_BTNS.concat(QUICK) });
    }
    const ans = image_('', lineImage_(ev.message.id)); const rp = reportLine_(); reply_(ev.replyToken, rp.short || ans, rp.msgs, true);
    return;
  }
  if (ev.message.type === 'audio') {
    if (!owner || uid !== owner) return;
    let said = '';
    try { said = transcribe_(lineContent_(ev.message.id), 'voice.m4a'); } catch (err) { console.error(err); }
    if (!said) return reply_(ev.replyToken, '語音聽不清楚，再說一次或改打字看看。', null, true);
    const ans = answer_(said);
    if (KIT_PENDING_) {
      reply_(ev.replyToken, '🎤 「' + said + '」\n\n' + ans, null, true);
      kitQueue_('line', uid);
      return;
    }
    const rp = reportLine_();
    const card = cardLine_();   // 智囊軍師的圖卡
    const voice = !rp.short && !card.length && voiceMode_() !== 'off' ? lineVoice_(ans) : [];   // 用講的就用講的回
    return reply_(ev.replyToken, rp.short ? '🎤 「' + said + '」\n\n' + rp.short : withVoice_(said, ans), rp.msgs.concat(card, caseLine_(), voice).slice(0, 4), true);
  }
  if (ev.message.type !== 'text') {
    if (uid === owner) reply_(ev.replyToken, '小乖目前看得懂文字、圖片和語音，其他類型還不行喔。', null, true);
    return;
  }

  const text = ev.message.text.trim();
  const bind = text.match(/^綁定\s*(\S+)$/);
  if (bind) {
    if (owner && owner !== uid) return;   // 已經有主人：別人一律不回
    if (bind[1] !== prop_('SYNC_KEY')) return reply_(ev.replyToken, '同步密碼不對喔，再確認一次。');
    setProp_('OWNER_USER_ID', uid);
    return reply_(ev.replyToken, '綁定完成！之後直接跟我說話就好。傳「說明」可以看我會做什麼。', null, true);
  }
  if (!owner) return reply_(ev.replyToken, '請先傳「綁定 你的同步密碼」完成綁定。');
  if (uid !== owner) return;   // 只回主人，其他人不回應

  const ans = answer_(text);
  if (KIT_PENDING_) {   // 7張＋PDF：先回「製作中」，做好用推播送
    reply_(ev.replyToken, ans, null, true);
    kitQueue_('line', uid);
    return;
  }
  const rp = reportLine_();
  const card = cardLine_();
  const media = caseLine_();   // 看見證／案例時的圖片、影片
  const voice = !rp.short && !card.length && !media.length && voiceMode_() === 'always' && !/^語音回覆/.test(text) ? lineVoice_(ans) : [];
  reply_(ev.replyToken, rp.short || ans, rp.msgs.concat(card, media, voice), true);
}

function lineContent_(messageId) {
  const res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('LINE 檔案下載失敗');
  return res.getBlob();
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
  const raw = String(text || '').trim();   // 原文（「改標題」後打的新標題可能用表情符號開頭）
  text = String(text || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();   // 按鈕前面的圖示去掉
  if (text === '說明' || /^\/?(help|start)$/i.test(text)) return { text: HELP_TEXT, buttons: [MENU[0], MENU[1], ['📖 更多說明']] };
  if (text === '更多說明') return { text: HELP_MORE, buttons: MENU };
  if (/^(選單|功能選單|功能|主選單|menu)$/i.test(text.replace(/\s+/g, ''))) return menuCard_();
  if (/^(對話頁|對話頁面|對話介面|小乖對話|語音頁)$/.test(String(text).replace(/\s+/g, ''))) return talkLink_();
  if (/^(🔎)?(見證庫|見證庫網頁|見證網頁)$/.test(String(text).replace(/\s+/g, ''))) return wallLink_();
  const vm = String(text).replace(/\s+/g, '').match(/^(?:語音回覆|語音對話|用語音回)(開|關|開啟|關閉|自動)?$/);
  if (vm) return voiceSwitch_(vm[1] || '');
  // 換真人語音：「換聲音」列出可選的聲音按鈕；按「🎤 柔和 shimmer」或打「換聲音 coral」「換回原本的聲音」就換
  const t2 = String(text).replace(/\s+/g, ' ').trim();
  if (/^(換回)?原本(的)?(聲音|語音)$/.test(t2.replace(/ /g, ''))) return voicePick_('nova');
  const vb = t2.match(/^(?:原本|柔和|溫暖|沉穩|男聲) ([a-z]+)$/i);
  if (vb) return voicePick_(vb[1]);
  const vc = t2.match(/^(?:換聲音|聲音|語音聲音|換語音|真人語音) ?([a-zA-Z]+)?$/);
  if (vc) return voicePick_(vc[1] || '');
  const sm = settingsMenu_(t2, raw);   // 「⚙️ 設定」按鈕：改圖卡署名、文案標題
  if (sm) return sm;
  const ce = caseEdit_(t2, raw);   // 「✏️ 改說明」：改某一則圖片／影片的說明
  if (ce) return ce;
  const cf = caseFind_(t2, raw);   // 「🔍 查詢案例」：打關鍵字找見證
  if (cf) return cf;
  const cd = caseDel_(t2);   // 「🗑️ 刪除見證」：問過確定才刪
  if (cd) return cd;
  const ef = evFlow_(t2, raw);   // 「➕ 新增行程」點日期→時間→事情；「🗑️ 10/20 15:00 開會」點一下就刪
  if (ef) return ef;
  const ad = addPending_(t2, raw);   // 「✍️ 新增筆記」按下後的下一句
  if (ad && ad.rewrite) return answer_(ad.rewrite);
  if (ad) return ad;
  const ap = autoAsk_(t2);   // 「自動發文 開／關」：每天晚上自動發智囊軍師 7 張圖卡
  if (ap) return ap;
  const ia = igAsk_(t2, raw);   // 「📤 發社群」：預覽 → 確定才發
  if (ia) return ia;
  const rl = reelsAsk_(t2);   // 「🎬 剪 Reels」：接下來 10 分鐘內傳的影片拿去剪
  if (rl) return rl;
  if (/^見證(案例)?$/.test(t2.replace(/\s+/g, ''))) return browseCat_(caseCats_().indexOf('見證案例') >= 0 ? '見證案例' : '其他');
  if (/^新增見證$/.test(t2.replace(/\s+/g, ''))) {
    setProp_('CASE_PENDING', caseCats_().indexOf('見證案例') >= 0 ? '見證案例' : '其他');
    setProp_('CASE_UNTIL', String(Date.now() + 10 * 60 * 1000));
    return { text: '➕ 新增見證\n\n' + caseGuide_(), buttons: [PHOTO_BTNS, ['✅ 存好了']] };
  }
  const lp = lineImgPick_(t2.replace(/\s+/g, ''));   // LINE 傳圖片後按「試算這張／存成見證／看圖說明」
  if (lp) return lp;
  if (casePending_() && /^(存好了|完成|好了|結束)$/.test(t2.replace(/\s+/g, ''))) {
    setProp_('CASE_UNTIL', '0');
    return { text: '✅ 見證收好了。按「💬 見證案例」可以看、轉傳分享。', buttons: [['💬 見證案例']].concat(QUICK) };
  }
  const cs = stratSetting_(t2);   // 「設定署名 …」「設定標題 …」
  if (cs) return cs;
  // 智囊軍師：選主題就寫文案（圖卡由 LINE／Telegram／對話頁各自畫好送出）
  const kp = kitPick_(raw);   // 「📕 7張＋PDF」：選主題後要做 1～2 分鐘，先回「製作中」，做好再傳
  if (kp === 'menu') return kitMenu_();
  if (kp && kp.style) return kitStyleMenu_(kp.style);
  if (kp) {
    if (busy_('KIT_BUSY', 8 * 60 * 1000)) return '⏳ 上一組 7張＋PDF 還在做，好了就傳給你，不用再按喔。';
    KIT_PENDING_ = kp;
    return '⏳ 收到！正在寫貼文、畫 7 張圖卡、做 PDF，大約 1～2 分鐘，好了就傳給你。';
  }
  const sp = stratPick_(raw) || stratPick_(t2);   // 先用原文對主題按鈕（「🌿 健康」要帶圖示才算按鈕）
  if (sp) return sp === 'menu' ? (VOICE_ONLY_ ? strategist_('auto') : stratMenu_()) : strategist_(sp);   // 只用聲音（嘿 小乖）沒按鈕可選，就讓軍師判定
  // 案例分類：列分類、看某一類、改剛存那筆的分類
  if (/^(案例分類|分類|案例庫)$/.test(text)) return caseCatsMenu_();
  const bc = text.match(/^(?:看分類\s*)?(.+?)（\d+）$/) || text.match(/^看分類\s*(.+)$/);
  if (bc && (caseCats_().indexOf(bc[1].trim()) >= 0 || bc[1].trim() === TEXT_CAT)) return browseCat_(bc[1].trim());
  const sc = text.match(/^分享案例\s*(\w+)$/); if (sc) return shareCase_(sc[1]);
  const np = text.match(/^(.+?)\s*第(\d+)頁$/);
  if (np && (caseCats_().indexOf(np[1].trim()) >= 0 || np[1].trim() === TEXT_CAT)) return browseCat_(np[1].trim(), np[2]);
  const ac = text.match(/^新增分類\s*(\S+)$/); if (ac) return editCaseCat_('add', ac[1]);
  const mc = text.match(/^(?:分類改名|改分類名稱?)\s*(\S+)\s*(?:改成|→|->)?\s*(\S+)$/); if (mc) return editCaseCat_('rename', mc[1], mc[2]);
  const dc = text.match(/^(?:刪除分類|刪分類)\s*(\S+)$/); if (dc) return editCaseCat_('delete', dc[1]);
  const rc = text.match(/^改分類\s*(.+)$/);
  if (rc) return recatCase_(rc[1].trim());
  // 找資料分兩種：本機（案例庫、待辦、筆記）和網路。只按按鈕沒給關鍵字，就等下一句（或語音）
  const wq = text.match(/^(?:上網找|上網查|網路找|網路查|上網搜尋)[\s：:]*([\s\S]*)$/);
  const lq = wq ? null : text.match(/^(?:本機找|本機查|找本機|找案例|查案例|找資料|查資料|搜尋|幫我查|幫我找|查(?=[\s：:])|找(?=[\s：:]))[\s：:]*([\s\S]*)$/);
  if (wq || lq) {
    const kw = (wq || lq)[1].trim(), mode = wq ? 'web' : 'local';
    if (kw) return search_(kw, mode);
    setProp_('SEARCH_UNTIL', String(Date.now() + 5 * 60 * 1000));
    setProp_('SEARCH_MODE', mode);
    return (mode === 'web' ? '🌐 要上網找什麼？' : '📁 要在本機找什麼？') + '打關鍵字或傳一段語音給我';
  }
  if (Number(prop_('SEARCH_UNTIL')) > Date.now() && !quoteState_()) {
    setProp_('SEARCH_UNTIL', '0');
    return search_(text, prop_('SEARCH_MODE') || 'local');
  }
  const flat = String(text).replace(/\s+/g, '');
  if (/^(邀請小乖|邀小乖|小乖邀請)$/.test(flat)) return groupSwitch_('開');
  const gm = flat.match(/^(?:群組|加入群組|開放群組)(開|關|開啟|關閉|狀態)?$/);
  if (gm) return groupSwitch_(gm[1] || '狀態');
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
    return { text: '好，請傳訂單圖片給我，我來算數量、金額和 PV。', buttons: [PHOTO_BTNS] };
  }
  if (/^(刪除行程|刪行程|刪掉行程)$/.test(flat)) return listDelEvents_();   // 「🗑️ 刪除行程」按鈕：列出接下來的行程，按一下就刪
  const dn = delByName_(text);   // 「刪除 開會」「🗑️ 刪 開會」：照名稱直接刪，不經過 AI
  if (dn) return dn;
  if (/^(今天行程|今日行程|今天的行程|今天有什麼行程[？?]?)$/.test(flat)) return listToday_();
  const da = dayAsk_(flat);
  if (da) {   // 記進聊天紀錄，接著問「那後天呢」AI 才接得上
    const ls = listDays_(da[0], da[1], da[2]);
    logChat_('user', text); logChat_('assistant', String(ls.text || ls));
    return ls;
  }
  if (/^(我的待辦|待辦|待辦清單|我的待辦事項)$/.test(flat)) return listTodos_();
  if (/^(我的筆記|筆記)$/.test(flat)) return listNotes_();
  if (/^(選照片|拍照)$/.test(text)) return '請按左下角的迴紋針 📎 選明細表照片傳給我，我會自動試算。';
  return chat_(text);
}

/* ============ 智囊軍師：一鍵選六大主題，寫文案＋圖卡 ============ */
// 六大主題對齊「智囊軍師」(asset/Work.html) 的資料收集分類；按主題按鈕就寫一篇文案，並畫成圖卡（跟試算報表一樣用簡報畫成圖片）
const STRAT_BTN = '🪶 智囊軍師';
// 反骨開頭（使用者 2026-10-17：停留率跟轉換率很低，開頭要改反骨）：軍師貼文、封面、7 張名單包共用
const STRAT_HOOK = '【反骨開頭】第一句決定別人會不會停下來。貼文第一行、封面主標和鉤子都要用反骨句：直接推翻大家以為對的常識，讓人一看就想「蛤？為什麼？」。句型例如「別再⋯⋯了」「你越⋯⋯，越⋯⋯」「⋯⋯不是你的錯，是⋯⋯」「大家都說⋯⋯，我偏不」「90% 的人都做反了」。只翻轉觀念，不罵人、不恐嚇，不用療效、收入或成效保證當反骨點；第一句 20 字內、單獨一行，第二句馬上接一個讓人對號入座的生活場景，不要用「你好」「今天想跟大家聊」這類暖場開頭。';
const STRAT_THEMES = [   // 順序（2026-10-16 使用者指定）：軍師、觀念、健康、草本、經營、行銷
  { k: 'auto', btn: '🪶 軍師', name: '智囊軍師判定',
    guide: '請你（智囊軍師）先在五大分類中判斷今天最適合發文的方向：觀念、健康、火山草本、經營、網路行銷，cat 填所選分類，再依該分類的規則寫：觀念只談觀念與生活道理，不寫身體、毒素、排毒；健康用大健康原理的比喻切入，案例只說個人感受、不寫療效；火山草本只寫理念、生活場景與包裝故事，不寫功效；經營寫給新手能照著做的方向，不提收入或成效保證；網路行銷只寫經營技巧，不寫業績。' },
  { k: 'concept', btn: '💡 觀念', name: '觀念主題',
    guide: '【觀念分享】只講觀念與道理（財富觀、經營觀、人生觀、自律、選擇等），用對比與反問帶出思考。嚴禁出現身體、毒素、排毒、保健、療效等字眼，不寫成健康文章。' },
  { k: 'health', btn: '🌿 健康', name: '健康主題',
    guide: '【健康分享】以大健康原理與生活比喻（例如鍋子、水管、警察、蒼蠅）解釋身體的道理；案例只說個人感受，遵守合規，不寫療效、不寫治療或改善疾病、不做前後對比。' },
  { k: 'herb', btn: '🌱 草本', name: '火山草本',
    guide: '【火山草本】只寫產品的理念、日常使用的生活場景與包裝故事（例如一天中怎麼使用、為什麼選擇它、包裝上想傳達的心意）。不寫功效、成分的療效描述，不使用治療、改善疾病、藥效等字眼，不做前後對比。' },
  { k: 'biz', btn: '🧭 經營', name: '經營主題',
    guide: '【經營方向】寫給完全新手看、能照著做的經營方向與心法（例如專屬邀約訊息、第一次面談、把你會的事拆成步驟、每天的節奏），用一個具體的生活場景切入。只給方向與做法，不提收入或成效保證。' },
  { k: 'net', btn: '📣 行銷', name: '網路行銷',
    guide: '【網路行銷】只寫經營技巧，例如如何讓人停留（開頭的鉤子、前三秒、段落節奏）、如何回留言（回覆的語氣與引導互動的方式）等實用做法。不寫業績、收入、獲利或任何成效保證，不提具體金額。' },
];
// 文案開頭只寫分類兩個字（使用者 2026-10-16）：選哪個主題就寫哪個；選「軍師」照 AI 判斷的五大主題填
const STRAT_CAT2 = { concept: '觀念', health: '健康', herb: '草本', biz: '經營', net: '行銷' };
function stratCat2_(k, cat) {
  if (STRAT_CAT2[k]) return STRAT_CAT2[k];
  const c = String(cat || '');
  for (const x in STRAT_CAT2) if (c.indexOf(STRAT_CAT2[x]) >= 0) return STRAT_CAT2[x];
  return c.replace(/主題$/, '').slice(0, 2) || '軍師';
}
const STRAT_AGAIN = '🔁 再寫一篇', STRAT_SWITCH = '🪶 換主題';
const STRAT_FOLDER = '小乖軍師圖卡';
const STRAT_NO_TAG = /康園道|分享|大健康/;   // 使用者指定：標籤不要出現這些字
let LAST_CARD_ = null;   // 剛寫好的文案；LINE／Telegram／對話頁各自把它畫成圖卡送出

function stratMenu_() {
  const b = STRAT_THEMES.map(t => t.btn);
  return { text: '🪶 智囊軍師\n\n選一個主題，我幫你寫一篇文案，再做成 3 張圖卡：\n（想收名單就按「📕 7張＋PDF」）', buttons: [b.slice(0, 2), b.slice(2, 4), b.slice(4, 6), [KIT_BTN]] };
}

// 認得「健康主題」「智囊軍師 健康」「軍師判定」「再寫一篇」這些說法；不是就回 null
function stratPick_(text) {
  // 主題按鈕（兩個字，前面有圖示）：照按鈕文字對應；單打「健康」「經營」這類字不會誤觸
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const hit = STRAT_THEMES.filter(x => x.btn === raw)[0];
  if (hit) return hit.k;
  // 語音聽寫會帶標點，也常說「小乖寫文案」「幫我寫一篇火山草本的文案」：先去掉標點和稱呼
  const t = String(text || '').replace(/[\s，,。.！!？?、：:「」]+/g, '').replace(/^(嘿|欸|哈囉)?小乖/, '').replace(/^(幫我|請|請你|麻煩)/, '');
  if (/^(來|寫|生|產生|生成|出)?(一篇|一則|個)?(文案|貼文)(吧)?$/.test(t)) return 'menu';
  const fw = t.match(/^(?:來|寫|生|產生|生成|出)(?:一篇|一則|個)?(?:關於|有關)?(.*?)(?:主題)?(?:的)?(?:文案|貼文)(?:吧)?$/);
  if (fw) {   // 「寫一篇健康的文案」「寫火山草本文案」
    const w = fw[1];
    if (/判定|軍師|隨便|你決定|你選/.test(w)) return 'auto';
    if (/火山|草本/.test(w)) return 'herb';
    if (/健康/.test(w)) return 'health';
    if (/觀念/.test(w)) return 'concept';
    if (/經營|新手/.test(w)) return 'biz';
    if (/網路|行銷|網銷/.test(w)) return 'net';
    return 'menu';
  }
  if (/^(智囊軍師|軍師|智囊|換主題|寫文案|軍師文案)$/.test(t)) return 'menu';
  if (/^(再寫一篇|再一篇|換一篇)$/.test(t)) return prop_('STRAT_LAST') || 'menu';
  let r = t.replace(/^(智囊軍師|軍師)(?=.)/, '');
  const pre = r !== t;
  r = r.replace(/文案$/, '');
  const map = { 軍師判定: 'auto', 智囊軍師判定: 'auto', 健康主題: 'health', 火山草本: 'herb', 觀念主題: 'concept', 經營主題: 'biz', 網路行銷: 'net', 草本主題: 'herb', 行銷主題: 'net' };
  if (map[r]) return map[r];
  if (pre) return { 判定: 'auto', 健康: 'health', 觀念: 'concept', 經營: 'biz' }[r] || null;
  return null;
}

function strategist_(k) {
  const th = STRAT_THEMES.filter(t => t.k === k)[0];
  if (!th) return stratMenu_();
  if (!prop_('OPENAI_API_KEY')) return '還沒設定 OpenAI 金鑰，沒辦法寫文案。';
  if (busy_('STRAT_BUSY', 3 * 60 * 1000)) return '✍️ 上一篇還在寫，寫好就傳給你，不用再按喔。';
  try { return stratWrite_(k, th); } finally { busyEnd_('STRAT_BUSY'); }
}
function stratWrite_(k, th) {
  setProp_('STRAT_LAST', k);
  let hist = [];
  try { hist = JSON.parse(prop_('STRAT_HIST') || '[]'); } catch (e) { hist = []; }
  const sys = [
    '你是「智囊軍師」，彥彬的社群文案高手，用《康園道》風格寫一篇可以直接貼到 Facebook、Instagram、LINE 的文案。',
    '【康園道寫作風格】短句為主，每句獨立一行有節奏；先描述一個大家都有的現象，讓人對號入座；用反問引發思考（例如「你有沒有發現⋯⋯」「可是很奇怪⋯⋯」）；段落間留白；像朋友分享，不說教、不推銷；繁體台灣用語。',
    '【本次主題】' + th.guide,
    STRAT_HOOK,
    '【要寫兩個版本，內容不能一樣】',
    '①文字貼文（post）：直接貼在 FB／IG／LINE 的完整文案。有自己的標題（post_title，15 字內，也要反骨）；第一行是一句反骨句，第二行起用一個具體生活場景或小故事接住，慢慢帶出道理，4 到 6 段，全文 220 到 320 字；結尾用一句問句收尾，讓人想一想；不要叫人留言或私訊（使用者 2026-10-16：圖卡文案不用引導留言）。',
    '②圖卡（cards）：要 3 張，放在圖片上的精簡版，不是貼文的節錄；固定順序：第 1 張封面（點出現象）→ 第 2 張翻轉觀念 → 第 3 張給一個做法，標題和內容都不能重複。',
    '每張圖卡只分三層：主標（title）只講一個重點；正文用短句；必要的條件或提醒才放補充。',
    '第 1 張封面：title 主標 12 字內（可用 \\n 分兩行），跟貼文標題不同；主標要是反骨句；hook 一句鉤子 16 字內，接著反骨點製造懸念（例如「問題不在你，在順序」），讓人想往下滑；封面不寫 body、gold。',
    '第 2、3 張：title 主標 12 字內，只講一個重點；body 正文 2 到 4 行、每行一句短句 14 字內；gold 反骨金句一句 20 字內：先順著大家以為的常識說，再用「真正的⋯⋯，從不⋯⋯」反轉，不加解釋。',
    '兩個版本共用 5 個主題標籤（標籤不可以出現「康園道」「分享」「大健康」這些字）。',
    '【不可以寫】具體金額、收入、業績或任何成效保證；療效、治療、改善疾病、前後對比；電話、地址等個人資料；不要叫人留言、私訊或索取東西。',
    hist.length ? '【避免重複】最近寫過的標題：' + hist.join('、') + '，這次換一個不同的切角。' : '',
    '只輸出 JSON：{"cat":"這篇的分類（觀念、健康、火山草本、經營、網路行銷其中之一）","post_title":"貼文標題","post":"貼文內文，句子之間換行，段落之間空一行","cards":[{"title":"封面主標","hook":"一句鉤子"},{"title":"主標","body":"正文，每行一句短句","gold":"反骨金句"},{...第三張}],"tags":["#詞","#詞","#詞","#詞","#詞"]}',
  ].filter(Boolean).join('\n');
  let c = null;
  try {
    const out = callOpenAI_(sys, [{ role: 'user', content: '請寫一篇「' + th.name + '」的文案。今天是 ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '。' }]);
    c = JSON.parse(String(out).slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  } catch (err) {
    console.error('智囊軍師失敗：' + err.message);
    return { text: '文案這次沒寫出來，再按一次試試看。', buttons: [[STRAT_AGAIN, STRAT_SWITCH]] };
  }
  // 3 張圖卡（舊格式只有一張也接受）
  const cards = (Array.isArray(c.cards) && c.cards.length ? c.cards : [c]).slice(0, 3).map((x, i) => ({
    title: String(x.title || th.name).trim(),
    body: String(x.body || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(),
    gold: String(x.gold || '').replace(/^【?反骨金句】?[：:]?/, '').trim(),
    hook: i === 0 ? String(x.hook || '').replace(/\r/g, '').trim() : '',
  })).filter(x => x.body || x.gold || x.hook);
  if (!cards.length) cards.push({ title: th.name, body: '', gold: '' });
  const card = {
    theme: th.name, cat: String(c.cat || '').replace(/主題$/, ''), cards: cards,
    title: cards[0].title, body: cards[0].body, gold: cards[0].gold,
    ptitle: String(c.post_title || c.title || th.name).trim(),
    post: noAsk_(String(c.post || '').replace(/\r/g, '')).replace(/\n{3,}/g, '\n\n').trim(),
    tags: (Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(/\s+/)).map(s => String(s).trim()).filter(Boolean)
      .filter(s => !STRAT_NO_TAG.test(s))
      .map(s => s.charAt(0) === '#' ? s : '#' + s).slice(0, 5),
  };
  // 火山草本（含軍師判定成火山草本）：結尾一定要附「以上是個人感受」
  card.note = k === 'herb' || /火山草本/.test(card.cat) ? '以上是個人感受' : '';
  // 圖卡上方寫「生活筆記「主題」」（軍師判定就寫它選的分類）
  card.topic = k === 'auto' ? (card.cat || '生活') : th.name.replace(/主題$/, '');
  card.label = k === 'auto' ? '智囊軍師判定' + (card.cat ? '・' + card.cat : '') : th.name;
  card.cat2 = stratCat2_(k, card.cat);
  hist.unshift(card.title);
  setProp_('STRAT_HIST', JSON.stringify(hist.slice(0, 10)));
  LAST_CARD_ = card;
  return { text: stratText_(card), buttons: [[STRAT_AGAIN, STRAT_SWITCH, KIT_BTN]].concat(igReady_() ? [[IG_BTN]] : [], MENU) };
}

// 使用者自訂：圖卡底部署名、文案最上面的標題（存在指令碼屬性，沒設定就用預設）
function cardBy_() { return prop_('CARD_BY') || CARD_BY; }
function stratHead_() { return prop_('STRAT_HEAD') || '🪶 智囊軍師'; }
function stratSetting_(t) {
  const m = String(t || '').trim().match(/^(?:設定|修改|更改|改)(圖卡署名|底部署名|署名|文案標題|軍師標題|標題)[\s：:]*(.*)$/);
  if (!m) return null;
  const by = /署名/.test(m[1]), key = by ? 'CARD_BY' : 'STRAT_HEAD', name = by ? '圖卡底部署名' : '文案標題';
  const v = m[2].trim().slice(0, 40), now = by ? cardBy_() : stratHead_() + '｜主題';
  if (!v) return '目前的' + name + '是：\n' + now + '\n\n要改請打「設定' + (by ? '署名' : '標題') + ' 新的字」，例如：\n設定' + (by ? '署名 彥彬｜生活筆記 @248zwwwu' : '標題 🪶 彥彬的文案');
  if (/^(預設|恢復預設|改回預設|原本|改回原本)$/.test(v)) {
    PropertiesService.getScriptProperties().deleteProperty(key);
    return '好，' + name + '改回預設：\n' + (by ? cardBy_() : stratHead_() + '｜主題');
  }
  setProp_(key, v);
  return '好，' + name + '改成：\n' + (by ? v : v + '｜主題') + '\n\n之後寫的文案都會用這個。' + (by ? '' : '（「｜主題」會自動換成那篇的主題）');
}

// 「⚙️ 設定」：列出目前的署名、標題，按「改署名／改標題」後下一句話就是新的內容
const SET_BTNS = [['✍️ 改署名', '🪶 改標題'], ['↩️ 署名預設', '↩️ 標題預設'], ['📝 改見證說明', '↩️ 見證說明預設']];
// 「➕ 新增見證」的說明文字，可以在「⚙️ 設定」改（存在指令碼屬性 CASE_GUIDE）
const CASE_GUIDE = '接下來 10 分鐘傳的圖片、影片，都會存成【見證案例】（可以一次選好幾張）。\n傳完按「✅ 存好了」。\n\n存好後按「💬 見證案例」就能看、轉傳分享。';
function caseGuide_() { return prop_('CASE_GUIDE') || CASE_GUIDE; }
// 「➕ 新增行程」「✍️ 新增筆記」：按了先問內容，5 分鐘內的下一句就照這個新增（回傳改寫後的句子交給 AI）
function addPending_(t, raw) {
  const flat = String(t || '').replace(/\s+/g, '');
  const pend = prop_('ADD_PENDING');
  if (pend) {
    setProp_('ADD_PENDING', '');
    const menuWord = [].concat.apply([], MENU.concat(MENU_GROUPS, QUICK)).some(b => b.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '') === flat);
    if (Number(prop_('ADD_UNTIL')) > Date.now() && !menuWord) {
      if (/^(取消|不用|算了)$/.test(flat)) return { text: '好，不新增。', buttons: MENU };
      return { rewrite: (pend === 'event' ? '新增行程：' : '幫我記下筆記：') + (raw || t) };
    }
  }
  const m = flat.match(/^新增(筆記)$/);
  if (!m) return null;
  setProp_('ADD_PENDING', m[1] === '行程' ? 'event' : 'note');
  setProp_('ADD_UNTIL', String(Date.now() + 5 * 60 * 1000));
  return { buttons: [['取消']], text: m[1] === '行程'
    ? '➕ 要新增什麼行程？直接打或用語音說，例如：\n明天下午3點 跟王姐喝咖啡\n10月20日 早上9點 開會\n\n（打「取消」就不新增）'
    : '✍️ 要記什麼？直接打或用語音說，例如：\n車位在 B2-35\n\n（打「取消」就不新增）' };
}
/* ============ 行程：用點的新增、刪除（不經過 AI，照你點的存，不會多加字） ============ */
const WEEK_ = '日一二三四五六';
const EV_TITLES = ['開會', '見客戶', '說明會', '上課', '聚餐', '看醫生'];
function evMd_(ds) { return Number(ds.slice(5, 7)) + '/' + Number(ds.slice(8, 10)); }
function evWk_(ds) { return '（' + WEEK_[new Date(ds + 'T12:00:00+08:00').getUTCDay()] + '）'; }
function evDelLabel_(e) { return '🗑️ ' + evMd_(e.date) + ' ' + (hm_(e.time) || '整天') + ' ' + e.title; }
function futureEvents_() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return readAll_().events.filter(e => e.date >= today).sort(evCmp_);
}
function evDay_(k) { return Utilities.formatDate(new Date(Date.now() + k * 86400000), TZ, 'yyyy-MM-dd'); }
// 「10/20」→ 今天起最近的那一天（月份比現在小就是明年）
function evDateOf_(mo, d) {
  const today = evDay_(0), y = Number(today.slice(0, 4));
  const ds = y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
  return ds < today ? (y + 1) + ds.slice(4) : ds;
}
// 打字也可以：「14:30」「下午3點半」「早上9點」
function evTimeOf_(t, period) {
  let m = t.match(/^(\d{1,2})[:：](\d{2})$/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return ('0' + Number(m[1])).slice(-2) + ':' + m[2];
  m = t.match(/^(上午|早上|中午|下午|晚上)?(\d{1,2})點(半|(\d{1,2})分?)?$/);
  if (!m) return '';
  let h = Number(m[2]); const p = m[1] || period || '';
  if (/下午|晚上/.test(p) && h < 12) h += 12;
  if (h > 23) return '';
  return ('0' + h).slice(-2) + ':' + (m[3] === '半' ? '30' : ('0' + Number(m[4] || 0)).slice(-2));
}
function evState_() { try { const s = JSON.parse(prop_('EV_ADD') || 'null'); return s && s.until > Date.now() ? s : null; } catch (e) { return null; } }
function evSave_(s) { s.until = Date.now() + 10 * 60 * 1000; setProp_('EV_ADD', JSON.stringify(s)); }
function evAsk_(s) {
  const head = s.date ? '📅 ' + evMd_(s.date) + evWk_(s.date) + (s.time ? ' ' + s.time : s.allDay ? ' 整天' : '') + '\n\n' : '';
  if (s.s === 'date') {
    const p = s.page || 0, days = [];
    for (let k = p * 10; k < p * 10 + 10; k++) {
      const ds = evDay_(k);
      days.push('📅 ' + evMd_(ds) + evWk_(ds) + (k === 0 ? '今天' : k === 1 ? '明天' : k === 2 ? '後天' : ''));
    }
    return { text: '➕ 新增行程\n\n① 哪一天？點下面的日期。\n（也可以打日期，例如 11/5）', buttons: [days, (p ? ['⬅️ 前面日期'] : []).concat(['➡️ 更多日期', '❌ 取消'])] };
  }
  if (s.s === 'period') return { text: head + '② 什麼時段？', buttons: [['🌅 上午', '☀️ 下午', '🌙 晚上', '🕘 整天'], ['⬅️ 重選日期', '❌ 取消']] };
  if (s.s === 'time') {
    const r = { 上午: [8, 12], 下午: [12, 18], 晚上: [18, 22] }[s.period], ts = [];
    for (let h = r[0]; h < r[1]; h++) ts.push(('0' + h).slice(-2) + ':00', ('0' + h).slice(-2) + ':30');
    return { text: head + '③ 幾點？點下面的時間。\n（也可以打，例如 14:45）', buttons: [ts, (ts.length < 12 ? ['⬅️ 換時段'] : []).concat(['❌ 取消'])] };
  }
  // 要做什麼：最近用過的名稱排前面，再補常用的
  const seen = {}, names = [];
  readAll_().events.slice().sort((a, b) => (b.u || 0) - (a.u || 0)).map(e => e.title).concat(EV_TITLES)
    .forEach(t => { t = String(t || '').trim(); if (t && t.length <= 14 && !seen[t] && names.length < 10) { seen[t] = 1; names.push(t); } });
  return { text: head + '④ 要做什麼？點下面的，或直接打／用語音說。\n（你打什麼就存什麼，小乖不會改字）', buttons: [names, ['❌ 取消']] };
}
// 有時間的行程自動加「開始前 30 分鐘」提醒（跟小乖主頁一樣；2026-10-16 使用者選「要提醒」）
function evRemind_(d, ev) {
  if (!ev.time) return false;
  const t = parseAt_(ev.date + 'T' + hm_(ev.time));
  if (!t || t - 30 * 6e4 <= Date.now()) return false;
  d.reminders.push({ id: uid_(), text: '30 分鐘後：' + ev.title + (ev.place ? '（' + ev.place + '）' : ''), at: fmtAt_(t - 30 * 6e4),
    repeat: 'none', fired: false, src: ev.id, u: Date.now() });
  return true;
}
function evFlow_(t, raw) {
  const flat = String(t || '').replace(/\s+/g, '');
  const rawS = String(raw || '').trim();
  // 刪除：按「🗑️ 10/20 15:00 開會」
  const dm = rawS.match(/^🗑️?\s*(\d{1,2})\/(\d{1,2}) (\d{2}:\d{2}|整天) (.+)$/);
  if (dm) {
    const md = ('0' + dm[1]).slice(-2) + '-' + ('0' + dm[2]).slice(-2), tm = dm[3] === '整天' ? '' : dm[3], title = dm[4].trim();
    const gone = withLock_(() => {
      const d = readAll_(), today = evDay_(0);
      const x = d.events.filter(e => e.date >= today && e.date.slice(5) === md && hm_(e.time) === tm && e.title === title).sort(evCmp_)[0];
      if (!x) return null;
      const now = Date.now();
      d.events = d.events.filter(e => e.id !== x.id); d.deleted[x.id] = now;
      d.reminders = d.reminders.filter(r => { if (r.src === x.id) { d.deleted[r.id] = now; return false; } return true; });
      writeAll_(d);
      return x;
    });
    if (!gone) return listDelEvents_('找不到這筆，可能已經刪掉了。');
    setProp_('EV_UNDO', JSON.stringify(gone));
    logChat_('user', rawS); logChat_('assistant', '🗑️ 已刪除行程：' + gone.title);
    return listDelEvents_('🗑️ 已刪除：' + evMd_(gone.date) + evWk_(gone.date) + ' ' + (gone.time || '整天') + '　' + gone.title);
  }
  if (/^(復原|復原行程)$/.test(flat) && prop_('EV_UNDO')) {
    const x = JSON.parse(prop_('EV_UNDO')); setProp_('EV_UNDO', '');
    withLock_(() => { const d = readAll_(); x.id = uid_(); x.u = Date.now(); d.events.push(x); evRemind_(d, x); writeAll_(d); });
    return listDelEvents_('↩️ 已經放回去了：' + evMd_(x.date) + ' ' + (x.time || '整天') + '　' + x.title);
  }
  if (flat === '刪好了') { setProp_('EV_UNDO', ''); return { text: '好，行程整理好了。', buttons: [['⏰ 今天行程', '📅 近期行程']].concat(MENU) }; }
  if (flat === '刪掉剛剛這筆') {
    const id = prop_('EV_LAST'); setProp_('EV_LAST', '');
    const x = id && readAll_().events.find(e => e.id === id);
    return x ? evFlow_('', evDelLabel_(x)) : { text: '剛剛那筆已經不在了。', buttons: MENU };
  }
  // 新增
  if (/^(新增行程|加行程|再加一筆)$/.test(flat)) { const s = { s: 'date' }; evSave_(s); return evAsk_(s); }
  const s = evState_();
  if (!s) return null;
  if (/^(取消|不用|算了|不加了)$/.test(flat)) { setProp_('EV_ADD', ''); return { text: '好，不新增。', buttons: MENU }; }
  const menuWord = [].concat.apply([], MENU.concat(MENU_GROUPS, QUICK)).some(b => b.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '') === flat);
  if (menuWord) { setProp_('EV_ADD', ''); return null; }   // 按了別的功能就不排了
  if (s.s === 'date') {
    if (flat === '更多日期') { s.page = (s.page || 0) + 1; evSave_(s); return evAsk_(s); }
    if (flat === '前面日期') { s.page = Math.max(0, (s.page || 0) - 1); evSave_(s); return evAsk_(s); }
    const m = flat.match(/^(\d{1,2})[\/月](\d{1,2})/);
    const rel = { 今天: 0, 明天: 1, 後天: 2 }[flat];
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31) s.date = evDateOf_(Number(m[1]), Number(m[2]));
    else if (rel !== undefined) s.date = evDay_(rel);
    else return Object.assign(evAsk_(s), { text: '請點下面的日期，或打像 11/5 這樣的日期。' });
    s.s = 'period'; evSave_(s); return evAsk_(s);
  }
  if (flat === '重選日期') { s.s = 'date'; delete s.time; delete s.allDay; evSave_(s); return evAsk_(s); }
  if (flat === '換時段') { s.s = 'period'; evSave_(s); return evAsk_(s); }
  if (s.s === 'period' || s.s === 'time') {
    const tm = evTimeOf_(flat, s.period);
    if (tm) { s.time = tm; s.s = 'title'; evSave_(s); return evAsk_(s); }
    if (s.s === 'period') {
      if (flat === '整天') { s.time = ''; s.allDay = true; s.s = 'title'; evSave_(s); return evAsk_(s); }
      if (/^(上午|下午|晚上)$/.test(flat)) { s.period = flat; s.s = 'time'; evSave_(s); return evAsk_(s); }
      return Object.assign(evAsk_(s), { text: '請點下面的時段，或打像 14:30 這樣的時間。' });
    }
    return Object.assign(evAsk_(s), { text: '請點下面的時間，或打像 14:45 這樣的時間。' });
  }
  // 要做什麼：照原文存，不經過 AI
  const title = rawS.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) return evAsk_(s);
  setProp_('EV_ADD', '');
  const now = Date.now(), ev = { id: uid_(), title: title, date: s.date, time: s.time || '', place: '', time0: now, u: now };
  const rem = withLock_(() => { const d = readAll_(); d.events.push(ev); const r = evRemind_(d, ev); writeAll_(d); return r; });
  setProp_('EV_LAST', ev.id);
  logChat_('user', '新增行程：' + title); logChat_('assistant', '🗓️ 行程：' + ev.date + ' ' + ev.time + ' ' + title);
  return { text: '✅ 行程加好了\n\n▍' + evMd_(ev.date) + evWk_(ev.date) + '\n・' + (ev.time || '整天') + '　' + title + (rem ? '\n\n🔔 開始前 30 分鐘會提醒你' : ''),
    buttons: [['➕ 再加一筆', '↩️ 刪掉剛剛這筆'], ['⏰ 今天行程', '📅 近期行程']].concat(MENU) };
}
function settingsMenu_(t, raw) {
  const flat = String(t || '').replace(/\s+/g, '');
  const pend = prop_('SET_PENDING');
  if (pend) {
    setProp_('SET_PENDING', '');
    const menuWord = [].concat.apply([], MENU.concat(SET_BTNS, QUICK)).some(b => b.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '') === flat);
    if (Number(prop_('SET_UNTIL')) > Date.now() && !menuWord) {
      if (/^(取消|不改|算了)$/.test(flat)) return { text: '好，不改。', buttons: MENU };
      if (pend === 'case') {
        setProp_('CASE_GUIDE', String(raw || t).trim().slice(0, 500));
        return { text: '好，「➕ 新增見證」的說明改成：\n\n' + caseGuide_(), buttons: MENU };
      }
      return { text: stratSetting_('設定' + (pend === 'by' ? '署名 ' : '標題 ') + (raw || t)), buttons: MENU };
    }
  }
  if (flat === '設定') {
    return { text: ['⚙️ 設定', '', '✍️ 圖卡署名：' + cardBy_(), '🪶 文案標題：' + stratHead_() + '｜主題',
      '📝 見證說明：' + caseGuide_().replace(/\s+/g, ' ').slice(0, 30) + '…', '',
      '按「改署名」「改標題」或「改見證說明」，再打新的字給我就好。'].join('\n'), buttons: SET_BTNS.concat(MENU) };
  }
  const ask = flat.match(/^改(署名|標題)$/);
  if (ask) {
    const by = ask[1] === '署名';
    setProp_('SET_PENDING', by ? 'by' : 'head');
    setProp_('SET_UNTIL', String(Date.now() + 5 * 60 * 1000));
    return by ? '請打新的圖卡署名，例如：\n彥彬｜生活筆記 @248zwwwu\n\n（打「取消」就不改）'
      : '請打新的文案標題，例如：\n🪶 彥彬的文案\n後面會自動接「｜主題」\n\n（打「取消」就不改）';
  }
  if (flat === '改見證說明') {
    setProp_('SET_PENDING', 'case');
    setProp_('SET_UNTIL', String(Date.now() + 5 * 60 * 1000));
    return '請打新的「➕ 新增見證」說明（可以分好幾行）。\n\n目前是：\n' + caseGuide_() + '\n\n（打「取消」就不改）';
  }
  if (flat === '見證說明預設') {
    PropertiesService.getScriptProperties().deleteProperty('CASE_GUIDE');
    return { text: '好，見證說明改回預設：\n\n' + caseGuide_(), buttons: MENU };
  }
  const rs = flat.match(/^(署名|標題)預設$/);
  if (rs) return { text: stratSetting_('設定' + rs[1] + ' 預設'), buttons: MENU };
  return null;
}

// 文案全文（可以直接複製貼上）
// 文字貼文跟圖卡分開寫：文字用貼文版（post），圖卡用精簡版（title／body／gold）
function postText_(c) {
  return [c.ptitle, '', c.post || c.body, '', c.post ? '' : c.gold, c.note, '', c.tags.join(' ')]
    .filter((s, i, a) => s !== '' || (a[i - 1] !== '' && i > 0)).join('\n').trim();
}
function stratText_(c) {
  return [stratHead_() + '｜' + (c.cat2 || c.label), '', postText_(c)]
    .filter((s, i, a) => s !== '' || (a[i - 1] !== '' && i > 0)).join('\n').trim();
}

// 圖卡版面（直式 4:5，黑曜石＋香檳金，跟小乖頁面同一套風格）
// 2026-10-16 使用者照「文字層級」重點改成三層：主標（一個重點）→ 正文（短句，金句當最後一句）→ 必要補充（小字）；
// 第 1 張有 hook 就是封面（只放主標＋一句鉤子＋往右滑）；標籤只留在貼文，不印在圖卡上
function cardLayout_(c, minH) {
  const W = 540, X = 64, TW = 412;
  const units = l => Array.from(l).reduce((u, ch) => u + (/[\x20-\x7e]/.test(ch) ? 0.55 : 1), 0);
  const lines = (s, size, w) => String(s || '').split('\n')
    .reduce((n, l) => n + Math.max(1, Math.ceil(units(l) / Math.floor((w - 14) / size))), 0);
  const cover = c.idx === 1 && !!c.hook;
  const H = Math.max(675, minH || 0), TOP = 92, BOT = c.note ? H - 112 : H - 92;
  // 主標：封面 48、內頁 40；放不下就縮（最小 30）
  let tf = cover ? 48 : 40;
  while (tf > 30 && lines(c.title, tf, TW) > (cover ? 3 : 2)) tf -= 2;
  const titleH = lines(c.title, tf, TW) * tf * 1.45;
  const RULE = 54;   // 主標下的細金線（含上下留白）
  // 正文 23 起，整塊放不下才縮（最小 17）
  let bf = 23;
  const blockH = f => cover
    ? titleH + RULE + lines(c.hook, 25, TW) * 25 * 1.7 + 70
    : titleH + RULE + (c.body ? lines(c.body, f, TW) * f * 1.85 : 0) + (c.gold ? 18 + lines(c.gold, f, TW) * f * 1.7 : 0);
  while (!cover && bf > 17 && blockH(bf) > BOT - TOP) bf--;
  const y0 = TOP + Math.max(0, Math.round((BOT - TOP - blockH(bf)) / 2));   // 整塊上下置中

  const build = slide => {
    const req = [];
    let k = 0;
    req.push({ updatePageProperties: { objectId: slide, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb_('#12100D') } } } }, fields: 'pageBackgroundFill.solidFill.color' } });
    const place = (w, h, x, yy) => ({ pageObjectId: slide,
      size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: h, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: yy, unit: 'PT' } });
    const shape = (type, x, yy, w, h, fill, outline) => {
      const id = 'xg_cs_' + slide + '_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: type, elementProperties: place(w, h, x, yy) } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'shapeBackgroundFill,outline', shapeProperties: {
        shapeBackgroundFill: fill ? { solidFill: { color: { rgbColor: rgb_(fill) } } } : { propertyState: 'NOT_RENDERED' },
        outline: outline ? { outlineFill: { solidFill: { color: { rgbColor: rgb_(outline) } } }, weight: { magnitude: 0.75, unit: 'PT' } } : { propertyState: 'NOT_RENDERED' } } } });
    };
    const text = (str, x, yy, w, h, size, color, o) => {
      o = o || {};
      const id = 'xg_ct_' + slide + '_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: place(w, h, x, yy) } });
      req.push({ insertText: { objectId: id, text: String(str) } });
      req.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'fontSize,bold,foregroundColor,fontFamily', style: {
        fontSize: { magnitude: size, unit: 'PT' }, bold: !!o.bold, fontFamily: o.serif ? 'Noto Serif TC' : 'Noto Sans TC',
        foregroundColor: { opaqueColor: { rgbColor: rgb_(color) } } } } });
      req.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'alignment,lineSpacing',
        style: { alignment: o.align || 'CENTER', lineSpacing: o.ls || 100 } } });
      req.push({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: o.valign || 'MIDDLE' }, fields: 'contentAlignment' } });
    };
    shape('RECTANGLE', 16, 16, W - 32, H - 32, null, '#C9A56A');
    shape('RECTANGLE', 22, 22, W - 44, H - 44, null, '#4A3F2C');
    text('生活筆記「' + (c.topic || c.label) + '」', X, 40, TW, 26, 14, '#B9A47A');   // 小字標示，不跟主標搶
    let y = y0;
    text(c.title, X, y, TW, titleH, tf, '#F1DFB4', { bold: true, serif: true, ls: 120 });   // ① 主標
    y += titleH + 26;
    shape('RECTANGLE', W / 2 - 30, y, 60, 1, '#C9A56A', null);
    y += RULE - 26;
    if (cover) {
      const hh = lines(c.hook, 25, TW) * 25 * 1.7;
      text(c.hook, X, y, TW, hh, 25, '#EDE6D6', { ls: 140 });   // ② 一句鉤子
      text('往右滑 →', X, y + hh + 36, TW, 24, 15, '#C9A56A');
    } else {
      if (c.body) {
        const bh = lines(c.body, bf, TW) * bf * 1.85;
        text(c.body, X, y, TW, bh, bf, '#EDE6D6', { ls: 150, valign: 'TOP' });   // ② 正文（短句置中）
        y += bh;
      }
      if (c.gold) text(c.gold, X, y + 18, TW, lines(c.gold, bf, TW) * bf * 1.7, bf, '#E2C27A', { bold: true, serif: true, ls: 130 });   // 金句＝正文最後一句
    }
    if (c.note) text(c.note, X, H - 104, TW, 22, 13, '#9C8F78');   // ③ 必要補充
    shape('RECTANGLE', W / 2 - 70, H - 72, 140, 0.8, '#C9A56A', null);
    text(cardBy_(), X, H - 66, TW, 28, 16, '#F1DFB4', { bold: true });
    if (c.total > 1) text(c.idx + ' / ' + c.total, W - 120, H - 60, 82, 24, 14, '#C9A56A', { serif: true, align: 'END' });
    return req;
  };
  return { W: W, H: H, build: build };
}

// 3 張圖卡：同一份簡報畫 3 頁，一次輸出（比一張一張開簡報快很多）
function cardPngs_(c) {
  const all = c.cards && c.cards.length ? c.cards : [c];
  const list = all.map((x, i) => Object.assign({}, c, x, { idx: i + 1, total: all.length }));
  const H = Math.max.apply(null, list.map(x => cardLayout_(x).H));
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm');
  return layoutPngs_(list.map(x => cardLayout_(x, H)),
    list.map((x, i) => '智囊軍師_' + c.theme + '_' + stamp + (list.length > 1 ? '_' + (i + 1) : '') + '.png'));
}

function saveCard_(png) {
  const it = DriveApp.getFoldersByName(STRAT_FOLDER);
  return (it.hasNext() ? it.next() : DriveApp.createFolder(STRAT_FOLDER)).createFile(png.copyBlob().setName(png.getName()));
}

function cardErrText_() {
  return '圖卡這次沒畫出來（文案在下面）。原因：' + reportErrText_().replace(/^報表圖片沒產生（文字試算如下）。原因：/, '');
}

// Telegram：先傳圖卡，再傳文案全文
function sendCardTg_(chatId) {
  const c = LAST_CARD_; LAST_CARD_ = null;
  if (!c) return false;
  REPORT_ERR_ = '';
  const pngs = cardPngs_(c);
  if (!pngs.length) { tgSend_(chatId, cardErrText_()); return false; }
  const files = [];
  pngs.forEach((png, i) => {
    try { files.push(saveCard_(png)); } catch (e) { console.error(e); }
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/sendPhoto', {
      method: 'post', muteHttpExceptions: true,
      payload: { chat_id: String(chatId), photo: png, caption: stratHead_() + '｜' + ((c.cards || [])[i] || c).title + (pngs.length > 1 ? '（' + (i + 1) + '/' + pngs.length + '）' : '') },
    });
    if (res.getResponseCode() !== 200) console.error('Telegram 圖卡傳送失敗：' + res.getContentText());
  });
  igRemember_(files, stratText_(c));   // 按「📤 發社群」就發這組
  return true;
}

// LINE：圖卡存雲端硬碟、設成知道連結的人都能看（跟試算報表一樣），回傳要一起送出的圖片訊息
function cardLine_() {
  const c = LAST_CARD_; LAST_CARD_ = null;
  if (!c) return [];
  REPORT_ERR_ = '';
  const pngs = cardPngs_(c);
  try {
    if (!pngs.length) throw new Error(REPORT_ERR_);
    const files = pngs.map(png => saveCard_(png));
    igRemember_(files, stratText_(c));
    return files.map(file => {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const url = 'https://lh3.googleusercontent.com/d/' + file.getId();
      return { type: 'image', originalContentUrl: url, previewImageUrl: url };
    });
  } catch (err) {
    REPORT_ERR_ = REPORT_ERR_ || err.message;
    console.error('LINE 圖卡失敗：' + REPORT_ERR_);
    return [{ type: 'text', text: cardErrText_() }];
  }
}

// 捷徑用：寫好文案並畫好圖卡，一次回給捷徑（文案拷貝到剪貼簿、圖卡存到相簿）
function cardApi_(ask) {
  const a = ask.replace(/\s+/g, '');
  let k = stratPick_(a) || stratPick_(a.replace(/主題$/, '')) || stratPick_(a + '主題');
  if (k === 'menu' || (!k && !a)) k = 'auto';   // 沒指定主題就讓軍師判定
  if (!k) return { ok: false, text: '請說主題：' + STRAT_THEMES.map(t => t.name.replace(/主題$/, '')).join('、'), img: '' };
  const ans = strategist_(k);
  const c = LAST_CARD_; LAST_CARD_ = null;
  if (!c) return { ok: false, text: String(ans && ans.text || ans), img: '' };
  REPORT_ERR_ = '';
  const pngs = cardPngs_(c);
  const files = [];
  pngs.forEach(png => { try { files.push(saveCard_(png)); } catch (e) { console.error(e); } });
  igRemember_(files, stratText_(c));
  const b64 = pngs.map(png => Utilities.base64Encode(png.getBytes()));
  return { ok: true, title: c.title, text: postText_(c),
    img: b64[0] || '', imgs: b64, err: b64.length ? '' : cardErrText_() };
}

// 對話頁：圖卡直接用 data URL 放進回覆，畫面上就看得到
function cardData_() {
  const c = LAST_CARD_; LAST_CARD_ = null;
  if (!c) return '';
  REPORT_ERR_ = '';
  const pngs = cardPngs_(c);
  if (!pngs.length) { ASK_SHOW_ = cardErrText_() + '\n\n' + ASK_SHOW_; return ''; }
  const files = [];
  pngs.forEach(png => { try { files.push(saveCard_(png)); } catch (e) { console.error(e); } });
  igRemember_(files, stratText_(c));
  ASK_IMGS_ = pngs.map(png => 'data:image/png;base64,' + Utilities.base64Encode(png.getBytes()));
  return ASK_IMGS_[0];
}

/* ============ 智囊軍師「📕 7張＋PDF」：7 張輪播圖卡＋這 7 張做成的 PDF（絲絨厚卡燙金風格） ============ */
// 2026-10-16 使用者選「兩種都留」：平常照樣 3 張；想收名單時按這個，留言關鍵字的人可以拿到 PDF
const KIT_BTN = '📕 7張＋PDF';
const KIT_FOLDER = '小乖軍師PDF';
const KIT_BG = 'https://yb131419.github.io/Tezhu/line-bot/kit/';   // 底圖（絲絨＋厚卡＋燙金框＋YB 印記），字由簡報疊上去
// 圖片網址加上內容指紋（?v=…）：圖一換（最多 2 分鐘），網址就跟著換，LINE／Telegram／簡報才不會拿到舊圖（使用者 2026-10-16：款式要同步更新）
function kitUrl_(path) {
  const url = KIT_BG + path;
  try {
    const cache = typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null, k = 'kv_' + path;
    let v = cache && cache.get(k);
    if (!v) {
      const r = UrlFetchApp.fetch(url + '?t=' + Date.now(), { muteHttpExceptions: true });   // 帶時間跳過網站快取，才算得到最新的圖
      if (r.getResponseCode() !== 200) return url;
      v = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, r.getContent()).slice(0, 5)
        .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
      if (cache) cache.put(k, v, 120);
    }
    return url + '?v=' + v;
  } catch (e) { return url; }
}
let LAST_KIT_ = null, KIT_PENDING_ = '';   // 剛寫好的 7 張＋PDF 內容；LINE／Telegram／對話頁各自畫好送出
// 款式（2026-10-16 使用者要「能選擇款式」）：底圖放在 line-bot/kit/<d>，字的顏色跟著換
const KIT_LIGHT = { ink: '#2A221A', soft: '#5B4F40', gold: '#A07C34', mute: '#8D7F6C', top: '#9C7A3E', lab: '#7C6B55', orn: '#B8914A', sub: '#6E604E', strike: '#A39A8C', rule: '#C9AE7A' };
const KIT_DARK = (soft, lab, mute) => ({ ink: '#F3EBDD', soft: soft, gold: '#D9B867', mute: mute, top: '#C9A65A', lab: lab, orn: '#C9A65A', sub: lab, strike: mute, rule: '#8C7440' });
// 暖灰款（原淺綠）封面：灰白色系「暖灰香檳」（使用者 2026-10-16 要灰白）——暖灰紙底＋香檳金框，墨黑大字、金色重點
const KIT_COVER_MINT = { ink: '#2A2620', gold: '#9C7A3E', top: '#9C7A3E', sub: '#5F574C', series: '#2A2620', by: '#2A2620' };   // 2026-10-16 改灰白色系（暖灰香檳）
const KIT_STYLES = [   // 使用者 2026-10-16 只留 V1（綠底）、L3（淺綠→2026-10-16 改暖灰香檳、改名暖灰）
  { n: '綠底', d: 'emerald/', tip: '封面黑金＋內頁象牙白卡、祖母綠底', c: KIT_LIGHT },
  { n: '暖灰', old: '淺綠', d: 'mint/', tip: '封面＋內頁暖灰香檳（暖灰紙、香檳金框）', cv: KIT_COVER_MINT, c: Object.assign({}, KIT_LIGHT, { ink: '#2A2620', soft: '#5F574C', mute: '#8A8276', lab: '#8A7A62', sub: '#6E655A' }) }];
let KIT_S_ = KIT_STYLES[0];   // 這次畫圖用的款式（kitMake_ 依 kit.style 設定）
const kitStyle_ = n => KIT_STYLES.filter(x => x.n === n || x.old === n)[0] || KIT_STYLES[0];   // 舊按鈕「淺綠」也認得

function kitMenu_() {
  const b = STRAT_THEMES.map(t => '📕 ' + t.btn.replace(/^[^\p{L}\p{N}]+/u, ''));
  return { text: '📕 7張＋PDF\n\n選一個主題：我寫一篇貼文、7 張輪播圖卡，再做一份同關鍵字的 PDF。\n最後一張圖卡會請大家留言關鍵字，你把 PDF 傳給他就好。\n（要做 1～2 分鐘）', buttons: [b.slice(0, 3), b.slice(3, 6)] };
}
// 「📕 7張＋PDF」→ 'menu'；「📕 健康」→ 'health'；不是就回 null
function kitPick_(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (t === KIT_BTN || /^(7張|七張)[＋+]?PDF$|^名單包$/i.test(t.replace(/^📕 ?|\s/g, ''))) return 'menu';
  const th = name => STRAT_THEMES.filter(x => x.btn.replace(/^[^\p{L}\p{N}]+/u, '') === name)[0];
  const st = t.match(/^🎨 ?(\S+?)・(\S+)$/);   // 「🎨 健康・綠底」：主題＋款式都選好了
  if (st) { const hit = th(st[1]); const sy = KIT_STYLES.filter(x => x.n === st[2] || x.old === st[2])[0]; return hit && sy ? hit.k + '|' + sy.n : null; }
  const m = t.match(/^📕 ?(\S+)$/);
  if (!m) return null;
  const hit = th(m[1]);
  return hit ? { style: hit } : null;
}
// 選好主題後問款式
function kitStyleMenu_(th) {
  const name = th.btn.replace(/^[^\p{L}\p{N}]+/u, '');
  const b = KIT_STYLES.map(x => '🎨 ' + name + '・' + x.n);
  const imgs = KIT_STYLES.map(x => kitUrl_(x.d + 'preview.jpg'));
  if (TALK_MODE_) ASK_IMGS_ = imgs;   // 對話頁直接顯示預覽圖
  return { text: '📕 ' + name + '：選一個款式\n\n' + KIT_STYLES.map(x => '・' + x.n + '：' + x.tip).join('\n'), buttons: [b],
    flex: kitStyleFlex_(name, imgs), alt: '🎨 選一個款式', imgs: imgs, caps: KIT_STYLES.map(x => x.n + '｜' + x.tip) };
}
// LINE：每款一張預覽卡，點「用這款」就開始做
function kitStyleFlex_(name, imgs) {
  return { type: 'carousel', contents: KIT_STYLES.map((x, i) => ({ type: 'bubble', size: 'kilo',
    hero: { type: 'image', url: imgs ? imgs[i] : kitUrl_(x.d + 'preview.jpg'), size: 'full', aspectRatio: '4:5', aspectMode: 'cover',
      action: { type: 'message', label: x.n, text: '🎨 ' + name + '・' + x.n } },
    body: { type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: '#FBF8F2', spacing: 'xs', contents: [
      { type: 'text', text: x.n, size: 'md', weight: 'bold', color: '#2A2118', align: 'center' },
      { type: 'text', text: x.tip, size: 'xxs', color: '#8D7F6C', align: 'center', wrap: true }] },
    footer: { type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: '#FBF8F2', contents: [
      { type: 'button', style: 'primary', color: '#A07C34', height: 'sm',
        action: { type: 'message', label: '用這款', text: '🎨 ' + name + '・' + x.n } }] } })) };
}

// AI 一次寫好：7 張輪播和短貼文（只回 JSON）
function kitWrite_(k) {
  const th = STRAT_THEMES.filter(t => t.k === k)[0];
  if (!th) return kitMenu_();
  if (!prop_('OPENAI_API_KEY')) return '還沒設定 OpenAI 金鑰，沒辦法寫文案。';
  let hist = [];
  try { hist = JSON.parse(prop_('KIT_HIST') || '[]'); } catch (e) { hist = []; }
  let kws = [];   // 最近用過的留言關鍵字（使用者 2026-10-16：草本一直是「火山草本／草本」，留言都一樣）
  try { kws = JSON.parse(prop_('KIT_KW_HIST') || '[]'); } catch (e) { kws = []; }
  const base = [
    '你是「智囊軍師」，彥彬的社群文案高手。這次要做一組「名單包」：一篇短貼文＋7 張 IG 輪播圖卡＋一份 PDF 實作手冊，講同一個主題。',
    '【三份內容不能一樣】（使用者 2026-10-16）貼文用一個生活故事帶出主題；圖卡只放重點和金句；PDF 是更完整的實作手冊（說明、示範句、練習、自我檢查）。三份不可以用同樣的句子，也不要互相照抄。',
    '寫法：內容簡短，字少、好讀；短句、每句獨立一行、像朋友分享，不說教、不推銷；繁體台灣用語。',
    '【本次主題】' + th.guide,
    '用 **字** 標出要強調的字，每段最多一處；換行用 \\n。',
    '【不可以寫】具體金額、收入、業績或任何成效保證；療效、治療、改善疾病、前後對比；電話、地址等個人資料；「私訊」一律改說「留言」。',
    STRAT_HOOK,
    '【留言引導】只放在最後一張圖卡（cta）；貼文和其他圖卡都不要叫人留言、私訊或索取（使用者 2026-10-16）。',
  ];
  // 第一段：7 張輪播＋貼文
  const sysA = base.concat([
    '【結構】主題是「○○的三個動作」這種能照著做的三步驟（series，10 字內，例如「邀約的三個動作」）；關鍵字 keyword 是 2 個字（例如「邀約」），讓人在最後一張留言索取 PDF。',
    '【關鍵字】keyword 要從這次的具體內容取（例如「熬夜」「早餐」「排便」「開口」），不可以用主題或分類名稱（火山草本、草本、健康、觀念、經營、行銷這類大詞），每次都要不一樣。' + (kws.length ? '最近用過：' + kws.join('、') + '，這次不可以再用。' : ''),
    '【7 張輪播 slides】剛好 7 張，依序 kind 為：cover、action、action、action、reason、last、cta。',
    'cover：head 是三行內的反骨鉤子（例如「約不到人，\\n不是你\\n**不會說**。」），sub 兩行（點出問題＋三個動作今天就用得上）。',
    'action ×3：step 寫「動作一／動作二／動作三」，head 兩行標題（每行 8 字內），body 3 到 5 行示範，可以用「~~錯誤說法~~」對比「**好的說法**」，全部 45 字內。',
    'reason：label 寫「○○，真正的原因」，head 四行內，點出真正的原因。',
    'last：pre 兩行鋪陳，head 兩行收尾金句。',
    'cta：最後一張，head 三行（例如「三個動作加上\\n練習句型——\\n**《○○的三個動作》**。」），cta 寫「留言「**關鍵字**」」，sub 寫「我把 PDF 整理好傳給你。」（整組只有這張引導留言）',
    '【貼文 post】post_title 15 字內；post 120 到 200 字，第一行一句反骨句，接著用生活場景，結尾用一句問句收尾，不要叫人留言、私訊或索取；tags 5 個主題標籤（不可以有「康園道」「分享」「大健康」）。',
    hist.length ? '【避免重複】最近做過：' + hist.join('、') + '，這次換一個不同的主題。' : '',
    '只輸出 JSON：{"cat":"分類","series":"","keyword":"","slides":[{"kind":"cover","label":"","head":"","sub":""},{"kind":"action","step":"動作一","head":"","body":""},{"kind":"action","step":"動作二","head":"","body":""},{"kind":"action","step":"動作三","head":"","body":""},{"kind":"reason","label":"","head":""},{"kind":"last","pre":"","head":""},{"kind":"cta","head":"","cta":"","sub":""}],"post_title":"","post":"","tags":[]}',
  ]).filter(Boolean).join('\n');
  // 第二段：PDF 實作手冊（照第一段的主題和三個動作寫，句子不能跟圖卡、貼文一樣）
  const sysB = base.concat([
    '這一次只寫「PDF 實作手冊」，主題和三個動作已經定好（會給你，還有圖卡和貼文已經用過的句子，PDF 不可以再用）。',
    '【PDF pdf】kicker 一句話（20 字內）；title 兩行（例如「邀約的\\n三個動作」）；intro 三行開場；',
    'before：title、lead（50 字內）、points 3 點（h 一句、p 30 到 45 字）、note {h:"用法", p:"一句說明怎麼用這份手冊"}；',
    'actions 剛好 3 個（對應三個動作）：step、title、lead（40 字內）、demo 2 句（可以用 ✗／✓ 開頭對比）、demoNote、why（50 字內）、practice（40 字內）、warn {h:"注意" 或 "原則", p:"40 字內"}；',
    'check：title、lead、items 5 個自我檢查問句、note {h, p}；final：title「今天就開始的三步」、steps 3 個 {h, p}、close 三行收尾（用 ** 標一個重點字）。PDF 裡不要叫人留言、私訊或索取。',
    '只輸出 JSON：{"pdf":{"kicker":"","title":"","intro":"","before":{"title":"","lead":"","points":[{"h":"","p":""}],"note":{"h":"","p":""}},"actions":[{"step":"動作一","title":"","lead":"","demo":["",""],"demoNote":"","why":"","practice":"","warn":{"h":"","p":""}}],"check":{"title":"","lead":"","items":[""],"note":{"h":"","p":""}},"final":{"title":"今天就開始的三步","steps":[{"h":"","p":""}],"close":""}}}',
  ]).join('\n');
  // 先寫 7 張圖卡＋短貼文，再寫 PDF；格式不對最多重寫，整段寫作最多 2 分鐘，留時間畫圖
  const model = prop_('KIT_MODEL') || 'gpt-4.1-mini';   // 寫長 JSON 又快又穩的模型（可在指令碼屬性 KIT_MODEL 改）
  const t0 = Date.now();
  let why = '';
  const ask = (sys, user, ok, fix) => {
    let msg = user;
    for (let i = 0; i < 3 && (i === 0 || Date.now() - t0 < 120000); i++) {
      try {
        const out = String(callOpenAI_(sys, [{ role: 'user', content: msg }], true, model, { maxTokens: 4000, temperature: 0.7 }));
        const c = kitUnwrap_(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)));
        const bad = ok(c);
        if (!bad) return c;
        why = '格式不對（' + bad + '）';
        msg = user + '\n上一次的 JSON 不完整：' + bad + '。' + fix;
      } catch (err) {
        why = /Timeout|逾時/i.test(err.message) ? 'AI 回覆太慢（逾時）' : err.message;
        if (/金鑰|429/.test(why)) break;
      }
      console.error('7張＋PDF 第 ' + (i + 1) + ' 次失敗：' + why);
    }
    return null;
  };
  const today = '今天是 ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '。';
  const a = ask(sysA, '請做一組「' + th.name + '」的名單包。' + today,
    c => { const n = kitSlides_(c.slides).length; return n < 7 ? 'slides 只有 ' + n + ' 張' : ''; },
    '這次一定要有 slides 剛好 7 張（cover、action×3、reason、last、cta）。');
  const used = a ? kitSlides_(a.slides).map(x => [x.head, x.body, x.sub, x.pre].filter(Boolean).join(' ')).join('\n') + '\n' + (a.post || '') : '';
  const b = a && ask(sysB, '主題：' + (a.series || th.name) + '\n關鍵字：' + (a.keyword || '') + '\n三個動作：\n'
      + kitSlides_(a.slides).filter(x => x.kind === 'action').map(x => (x.step || '') + '：' + String(x.head || '').replace(/\*\*|\\n|\n/g, '')).join('\n')
      + '\n\n圖卡和貼文已經用過的句子（PDF 不可以再用）：\n' + used.replace(/\*\*|~~/g, '').slice(0, 1500),
    c => { const n = c.pdf && Array.isArray(c.pdf.actions) ? c.pdf.actions.length : 0; return n < 3 ? 'pdf.actions 只有 ' + n + ' 個' : ''; },
    '這次一定要有 pdf.actions 剛好 3 個。');
  if (a && !b) console.error('7張＋PDF：PDF 手冊沒寫出來，PDF 改用 7 張圖卡');
  const kit = a ? kitClean_(Object.assign({}, a, { slides: kitSlides_(a.slides), pdf: b ? b.pdf : null }), th, k, kws) : null;
  if (!kit) {
    if (a) why = why || '內容不完整';
    return { text: /金鑰/.test(why) ? 'OpenAI 金鑰無效，沒辦法寫文案，請檢查 OPENAI_API_KEY。'
      : /429/.test(why) ? 'OpenAI 額度或速度上限到了（429），等一下再按一次；一直這樣請到 OpenAI 網站確認帳戶餘額。'
      : '這次沒寫出來（原因：' + String(why || '不明').slice(0, 120) + '），再按一次試試看。', buttons: [[KIT_BTN]] };
  }
  hist.unshift(kit.series);
  setProp_('KIT_HIST', JSON.stringify(hist.slice(0, 10)));
  setProp_('KIT_KW_HIST', JSON.stringify([kit.keyword].concat(kws.filter(x => x !== kit.keyword)).slice(0, 15)));
  LAST_KIT_ = kit;
  return { text: stratHead_() + '｜' + kit.cat2 + '\n\n' + postText_(kit), buttons: [[KIT_BTN, STRAT_SWITCH]].concat(igReady_() ? [[IG_BTN]] : [], MENU) };
}

// 7 張輪播：AI 偶爾漏寫 kind 或順序錯，照位置補上（cover、action×3、reason、last、cta）
const KIT_KINDS = ['cover', 'action', 'action', 'action', 'reason', 'last', 'cta'];
function kitSlides_(s) {
  const arr = (Array.isArray(s) ? s : s && typeof s === 'object' ? Object.keys(s).map(x => s[x]) : []).filter(x => x && typeof x === 'object');
  if (arr.length !== 7) return arr.filter(x => x.kind);
  return arr.map((x, i) => Object.assign({}, x, { kind: KIT_KINDS.indexOf(x.kind) >= 0 ? x.kind : KIT_KINDS[i] }));
}

// 整理 AI 回來的內容：補齊欄位、拿掉禁字（私訊→留言）；缺太多就回 null
// 有時 AI 會多包一層（{"kit":{…}}、{"名單包":{…}}）
function kitUnwrap_(c) {
  c = c || {};
  if (!c.slides && !c.pdf) {
    const inner = Object.keys(c).map(x => c[x]).filter(v => v && typeof v === 'object' && (v.slides || v.pdf))[0];
    if (inner) return inner;
  }
  if (c.slides && !Array.isArray(c.slides) && typeof c.slides === 'object') c.slides = Object.keys(c.slides).map(x => c.slides[x]);
  return c;
}
// 拿掉叫人留言／私訊／索取的句子（使用者 2026-10-16：圖卡文案不用引導留言）
const NO_ASK = /(歡迎|請|記得|快|來|一起|在)?[^\n。！？]{0,6}(留言|私訊|敲我|索取|領取)[^\n。！？]{0,14}(「|關鍵字|PDF|給你|我|喔|哦|吧|！)/;
function noAsk_(t) {
  return String(t || '').split('\n').map(l => l.split(/(?<=[。！？])/).filter(x => !NO_ASK.test(x)).join('')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
// 留言關鍵字：不能是主題大詞、不能跟最近重複；AI 給的不行就從系列名稱挑兩個字
const KIT_KW_BAN = /草本|火山|健康|觀念|經營|行銷|網路|保健|養生|分享|康園/;
function kitKeyword_(kw, series, recent) {
  const used = (recent || []).map(String);
  const good = w => w && w.length >= 2 && !KIT_KW_BAN.test(w) && used.indexOf(w) < 0;
  if (good(kw)) return kw;
  const t = String(series || '').replace(/的?[三3]個動作$|[《》，、。\s]/g, '').replace(new RegExp(KIT_KW_BAN.source, 'g'), '｜');
  const ws = t.split(/[｜的]/).filter(Boolean);   // 先挑完整的詞（兩個字一組），再退而求其次
  for (const p of ws) for (let i = 0; i + 2 <= p.length; i += 2) if (good(p.slice(i, i + 2))) return p.slice(i, i + 2);
  for (const p of ws) for (let i = 1; i + 2 <= p.length; i += 2) if (good(p.slice(i, i + 2))) return p.slice(i, i + 2);
  return kw || t.slice(0, 2);
}
function kitClean_(c, th, k, recent) {
  c = kitUnwrap_(c);
  const fix = v => typeof v === 'string' ? v.replace(/私訊/g, '留言').replace(/\r/g, '').trim()
    : Array.isArray(v) ? v.map(fix) : v && typeof v === 'object' ? Object.keys(v).reduce((o, x) => (o[x] = fix(v[x]), o), {}) : v;
  c = fix(c || {});
  const S = v => String(v == null ? '' : v);
  const slides = Array.isArray(c.slides) ? c.slides.filter(x => x && x.kind).slice(0, 7) : [];
  if (slides.length < 7) return null;
  const series = S(c.series).replace(/[《》]/g, '') || th.name;
  const keyword = kitKeyword_(S(c.keyword).replace(/[「」\s]/g, '').slice(0, 4), series, recent);
  const kit = {
    theme: th.name, k: k, series: series, keyword: keyword, cat: S(c.cat).replace(/主題$/, ''),
    slides: slides.map(x => ({ kind: S(x.kind), label: S(x.label), step: S(x.step), head: S(x.head), body: S(x.body),
      sub: x.kind === 'cta' ? S(x.sub) : noAsk_(S(x.sub)), pre: S(x.pre), cta: x.kind === 'cta' ? S(x.cta) || '留言「**' + keyword + '**」' : '' })),
    ptitle: S(c.post_title) || series, post: noAsk_(S(c.post)).replace(/\n{3,}/g, '\n\n'), gold: '', body: '', note: '',
    tags: (Array.isArray(c.tags) ? c.tags : S(c.tags).split(/\s+/)).map(s => S(s).trim()).filter(Boolean)
      .filter(s => !STRAT_NO_TAG.test(s)).map(s => s.charAt(0) === '#' ? s : '#' + s).slice(0, 5),
  };
  const P = c.pdf;   // PDF 手冊（沒寫出來就用 7 張圖卡做 PDF）
  kit.pdf = P && Array.isArray(P.actions) && P.actions.length >= 3 ? {
    kicker: S(P.kicker), title: S(P.title) || series, intro: S(P.intro),
    before: Object.assign({ title: '', lead: '', points: [], note: null }, P.before || {}),
    actions: P.actions.slice(0, 3).map(a => Object.assign({ step: '', title: '', lead: '', demo: [], demoNote: '', why: '', practice: '', warn: null }, a)),
    check: Object.assign({ title: '你最常卡在哪一個', lead: '', items: [], note: null }, P.check || {}),
    final: Object.assign({ title: '今天就開始的三步', steps: [], close: '' }, P.final || {}),
  } : null;
  kit.label = '《' + series + '》（留言「' + keyword + '」）';
  kit.cat2 = stratCat2_(k, kit.cat);
  return kit;
}

// 一段字（**強調**、~~劃掉~~）→ 純文字＋樣式範圍；簡報 API 用 UTF-16 位置，跟 JS 字串一樣
function kitRuns_(s) {
  const out = { text: '', marks: [] };
  const re = /\*\*(.+?)\*\*|~~(.+?)~~/g;
  let last = 0, m;
  const str = String(s || '');
  while ((m = re.exec(str))) {
    out.text += str.slice(last, m.index);
    const a = out.text.length;
    out.text += m[1] || m[2];
    out.marks.push({ a: a, b: out.text.length, em: !!m[1] });
    last = re.lastIndex;
  }
  out.text += str.slice(last);
  return out;
}
// 一個文字框放好幾段，每段自己的字級、顏色、對齊、段前距；強調字用 o.em（顏色）＋粗體
function kitText_(req, slide, id, box, paras, valign) {
  req.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: slide,
    size: { width: { magnitude: box[2], unit: 'PT' }, height: { magnitude: box[3], unit: 'PT' } },
    transform: { scaleX: 1, scaleY: 1, translateX: box[0], translateY: box[1], unit: 'PT' } } } });
  let text = '', at = [];
  // 段內換行拆成好幾段（同樣式，只有第一行有段前距）
  paras = [].concat.apply([], paras.filter(p => p && String(p.t || '') !== '')
    .map(p => String(p.t).split('\n').map((l, j) => Object.assign({}, p, { t: l || ' ', above: j ? 0 : p.above }))));
  paras.forEach((p, i) => {
    const r = kitRuns_(p.t);
    const a = text.length;
    text += r.text + (i < paras.length - 1 ? '\n' : '');
    at.push({ p: p, a: a, b: a + r.text.length, marks: r.marks.map(x => ({ a: a + x.a, b: a + x.b, em: x.em })) });
  });
  if (!text) return;
  req.push({ insertText: { objectId: id, text: text } });
  at.forEach(x => {
    const p = x.p, rng = { type: 'FIXED_RANGE', startIndex: x.a, endIndex: Math.max(x.b, x.a + 1) };
    if (x.b > x.a) req.push({ updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: x.a, endIndex: x.b }, fields: 'fontSize,bold,foregroundColor,fontFamily', style: {
      fontSize: { magnitude: p.size, unit: 'PT' }, bold: !!p.bold, fontFamily: p.font || 'Noto Serif TC',
      foregroundColor: { opaqueColor: { rgbColor: rgb_(p.color || KIT_S_.c.ink) } } } } });
    req.push({ updateParagraphStyle: { objectId: id, textRange: rng, fields: 'alignment,lineSpacing,spaceAbove,indentStart,indentFirstLine', style: {
      alignment: p.align || 'CENTER', lineSpacing: p.ls || 140, spaceAbove: { magnitude: p.above || 0, unit: 'PT' },
      indentStart: { magnitude: p.indent || 0, unit: 'PT' }, indentFirstLine: { magnitude: p.indent || 0, unit: 'PT' } } } });
    x.marks.forEach(m => req.push({ updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: m.a, endIndex: m.b },
      fields: m.em ? 'bold,foregroundColor' : 'strikethrough,foregroundColor',
      style: m.em ? { bold: true, foregroundColor: { opaqueColor: { rgbColor: rgb_(p.em || KIT_S_.c.gold) } } }
        : { strikethrough: true, foregroundColor: { opaqueColor: { rgbColor: rgb_(KIT_S_.c.strike) } } } } }));
  });
  req.push({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: valign || 'MIDDLE' }, fields: 'contentAlignment' } });
}
function kitBg_(req, slide, file, W, H) {
  req.push({ createImage: { objectId: slide + '_bg', url: kitUrl_(KIT_S_.d + file), elementProperties: { pageObjectId: slide,
    size: { width: { magnitude: W, unit: 'PT' }, height: { magnitude: H, unit: 'PT' } },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'PT' } } } });
}
const KIT_ORN = '───────　◆　───────';

// 一張輪播圖卡（540×675，跟 3 張圖卡同尺寸）
function kitCardLayout_(kit, i) {
  const W = 540, H = 675, s = kit.slides[i], N = kit.slides.length;
  const head = (t, size) => ({ t: t, size: size, bold: true, color: KIT_S_.c.ink, ls: 135 });
  const orn = { t: KIT_ORN, size: 9, color: KIT_S_.c.orn, above: 16 };
  const body = t => ({ t: t, size: 18, color: KIT_S_.c.soft, ls: 175, above: 16, em: KIT_S_.c.ink });
  let paras;
  if (s.kind === 'cover') paras = [head(s.head, 40), orn, body(s.sub)];
  else if (s.kind === 'action') paras = [head(s.head, 34), orn, body(s.body)];
  else if (s.kind === 'reason') paras = [head(s.head, 32)];
  else if (s.kind === 'last') paras = [{ t: s.pre, size: 25, color: KIT_S_.c.mute, ls: 160 }, orn, Object.assign(head(s.head, 40), { above: 14 })];
  else paras = [head(s.head, 27), orn, { t: '留言', size: 14, color: KIT_S_.c.sub, above: 18 },   // 整組只有最後一張引導留言（使用者 2026-10-16）
    { t: kit.keyword.split('').join(' '), size: 54, bold: true, color: KIT_S_.c.gold, above: 2 }, { t: s.sub, size: 16, color: KIT_S_.c.sub, above: 10 }];
  const label = s.kind === 'action' ? s.step : s.label || (s.kind === 'cover' ? '生活筆記「' + (kit.cat || kit.theme.replace(/主題$/, '')) + '」' : '');
  const num = ('0' + (i + 1)).slice(-2) + ' — ' + ('0' + N).slice(-2);
  if (s.kind === 'cover') return kitCoverLayout_(kit, s, num, W, H);
  return { W: W, H: H, build: slide => {
    const req = [];
    kitBg_(req, slide, 'card_bg.jpg', W, H);
    // 上方系列名＋分類、下方頁碼＋署名：使用者 2026-10-16 圈出來要放大
    kitText_(req, slide, slide + '_top', [40, 110, 460, 62], [
      { t: 'NO. ' + ('0' + (i + 1)).slice(-2) + ' · ' + kit.series, size: 15, bold: true, color: KIT_S_.c.top, font: 'Noto Sans TC' },
      { t: label, size: 19, bold: true, color: KIT_S_.c.lab, font: 'Noto Sans TC', above: 4 }], 'TOP');
    kitText_(req, slide, slide + '_main', [64, 178, 412, 372], paras);
    kitText_(req, slide, slide + '_ft', [40, 552, 460, 66], [
      { t: num, size: 20, bold: true, color: KIT_S_.c.top, font: 'Cormorant Garamond' },
      { t: cardBy_(), size: 16, bold: true, color: KIT_S_.c.soft, font: 'Noto Sans TC', above: 4 }], 'TOP');
    return req;
  } };
}

// 封面：黑金精品（使用者 2026-10-16 選 A）——黑曜石底＋雙層香檳金框，象牙白大標題靠左，不放領取 PDF
const KIT_COVER = { ink: '#F4EEE2', gold: '#D9BC7E', top: '#C9A56A', sub: '#B9AE9B', series: '#E9D3A2', by: '#F1DFB4' };
function kitCoverLayout_(kit, s, num, W, H) {
  const C = KIT_S_.cv || KIT_COVER, cat = kit.cat || String(kit.theme || '').replace(/主題$/, '');
  // 大標字級：最長一行要放得下（留空間給句尾標點，才不會「，」單獨掉一行），整塊字也不能超出上下兩條線（使用者 2026-10-16）
  const lines = String(s.head || '').replace(/\*\*|~~/g, '').split('\n');
  const longest = Math.max.apply(null, lines.map(l => l.length));
  const subLines = String(s.sub || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 18)), 0);
  let size = Math.max(34, Math.min(70, Math.floor(340 / Math.max(longest, 1))));
  while (size > 34 && lines.length * size * 1.25 + 24 + subLines * 31 > 380) size -= 2;
  return { W: W, H: H, build: slide => {
    const req = [];
    kitBg_(req, slide, 'cover_bg.jpg', W, H);
    kitText_(req, slide, slide + '_top', [75, 74, 250, 36], [
      { t: ('生活筆記' + (cat ? '・' + cat : '')).split('').join(' '), size: 15, bold: true, color: C.top, font: 'Noto Sans TC', align: 'START' }], 'TOP');
    kitText_(req, slide, slide + '_no', [325, 70, 140, 40], [
      { t: num, size: 20, color: C.top, font: 'Cormorant Garamond', align: 'END' }], 'TOP');
    // 從上方短金線（118）下面開始往下排，不再置中往上長；底線在 540
    kitText_(req, slide, slide + '_main', [75, 136, 400, 396], [
      { t: s.head, size: size, bold: true, color: C.ink, em: C.gold, ls: 120, align: 'START' },
      { t: s.sub, size: 20, color: C.sub, ls: 150, above: 24, align: 'START' }], 'TOP');
    kitText_(req, slide, slide + '_ser', [75, 552, 260, 34], [
      { t: kit.series, size: 18, bold: true, color: C.series, font: 'Noto Sans TC', align: 'START' }]);
    kitText_(req, slide, slide + '_sw', [335, 552, 130, 34], [
      { t: 'SWIPE  →', size: 19, color: C.top, font: 'Cormorant Garamond', align: 'END' }]);
    kitText_(req, slide, slide + '_by', [40, 594, 460, 34], [   // 使用者 2026-10-16：底下署名要亮、要大
      { t: cardBy_(), size: 16, bold: true, color: C.by, font: 'Noto Sans TC' }]);
    return req;
  } };
}

// PDF 實作手冊（A4 直式 595×842，內容跟圖卡、貼文不一樣；使用者 2026-10-16）
function kitPdfLayouts_(kit) {   // 2026-10-16 使用者：PDF 字太小 → 字放大、版面拉寬、段落改成「標題＋內文」
  const W = 595.28, H = 841.89, P = kit.pdf, X = 60, TW = 475;
  const lbl = t => ({ t: '— ' + t, size: 15, bold: true, color: KIT_S_.c.gold, font: 'Noto Sans TC', align: 'START', above: 24 });
  const txt = (t, o) => Object.assign({ t: t, size: 18, color: KIT_S_.c.soft, align: 'START', ls: 160, above: 6, em: KIT_S_.c.gold }, o || {});
  const lead = t => txt(t, { size: 20, color: KIT_S_.c.ink, ls: 155, above: 0 });
  const note = n => n && (n.h || n.p) ? [lbl(n.h || '注意'), txt(n.p, { color: KIT_S_.c.ink })] : [];
  const page = (n, small, title, paras) => ({ W: W, H: H, build: slide => {
    const req = [];
    kitBg_(req, slide, 'pdf_page.jpg', W, H);
    kitText_(req, slide, slide + '_hd', [X, 62, TW, 100], [{ t: small, size: 14, bold: true, color: KIT_S_.c.gold, font: 'Noto Sans TC', align: 'START' },
      { t: title, size: 34, bold: true, color: KIT_S_.c.ink, align: 'START', above: 4, ls: 120 }], 'BOTTOM');
    req.push({ createShape: { objectId: slide + '_rule', shapeType: 'RECTANGLE', elementProperties: { pageObjectId: slide,
      size: { width: { magnitude: TW - 14, unit: 'PT' }, height: { magnitude: 0.8, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: X + 7, translateY: 170, unit: 'PT' } } } });
    req.push({ updateShapeProperties: { objectId: slide + '_rule', fields: 'shapeBackgroundFill,outline', shapeProperties: {
      shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb_(KIT_S_.c.rule) } } }, outline: { propertyState: 'NOT_RENDERED' } } } });
    kitText_(req, slide, slide + '_bd', [X, 184, TW, 598], paras, 'TOP');
    kitText_(req, slide, slide + '_ft', [X, 786, TW, 24], [{ t: cardBy_() + '　　' + ('0' + n).slice(-2), size: 11, color: KIT_S_.c.mute, font: 'Noto Sans TC', align: 'END' }], 'TOP');
    return req;
  } });
  const pts = list => [].concat.apply([], (list || []).map((x, i) => [
    { t: '0' + (i + 1) + '　' + (x.h || ''), size: 20, bold: true, color: KIT_S_.c.ink, align: 'START', above: 18 }, txt(x.p, { ls: 150, above: 4 })]));
  const L = [];
  L.push({ W: W, H: H, build: slide => {   // 封面
    const req = [];
    kitBg_(req, slide, 'pdf_cover.jpg', W, H);
    kitText_(req, slide, slide + '_main', [X, 180, TW, 560], [
      { t: P.kicker, size: 17, bold: true, color: KIT_S_.c.gold, font: 'Noto Sans TC' },
      { t: P.title + '。', size: 58, bold: true, color: KIT_S_.c.ink, ls: 125, above: 24 },
      { t: '────────', size: 12, color: KIT_S_.c.orn, above: 22 },
      { t: P.intro, size: 20, color: KIT_S_.c.soft, ls: 170, above: 24 }]);
    kitText_(req, slide, slide + '_ft', [X, 752, TW, 26], [{ t: cardBy_(), size: 12, color: KIT_S_.c.mute, font: 'Noto Sans TC' }], 'TOP');
    return req;
  } });
  const B = P.before;
  L.push(page(2, '開始之前', B.title || '真正的原因', [lead(B.lead)].concat(pts(B.points), note(B.note))));
  P.actions.forEach((a, i) => L.push(page(3 + i, a.step || ('動作' + '一二三'[i]), a.title, [lead(a.lead),
    lbl('示範'), txt((a.demo || []).join('\n'), { color: KIT_S_.c.ink, size: 18 }), txt(a.demoNote),
    lbl('為什麼有用'), txt(a.why), lbl('練習'), txt(a.practice)].concat(note(a.warn)))));
  const C = P.check;
  L.push(page(6, '自查', C.title, [lead(C.lead)].concat((C.items || []).slice(0, 6).map((t, i) =>
    ({ t: '☐　' + t, size: 19, bold: true, color: KIT_S_.c.ink, align: 'START', above: 22, ls: 150 })), note(C.note))));
  const F = P.final;
  L.push(page(7, '最後', F.title, pts(F.steps).concat([{ t: KIT_ORN, size: 12, color: KIT_S_.c.orn, above: 34 },
    { t: F.close, size: 30, bold: true, color: KIT_S_.c.ink, ls: 150, above: 18 }])));
  return L;
}

// 畫 7 張圖卡＋PDF，存到雲端硬碟（PDF 設成知道連結的人都能看，才能轉給留言的人）
function kitMake_(kit) {
  REPORT_ERR_ = '';
  KIT_S_ = kitStyle_(kit.style);
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm');
  const names = kit.slides.map((x, i) => '名單包_' + kit.series + '_' + stamp + '_' + (i + 1) + '.png');
  const pdfName = '《' + kit.series + '》（' + kit.keyword + '）.pdf';
  // 有 PDF 手冊：圖卡和 PDF 各畫一份；沒有：同一份簡報畫 7 張，整份匯出成 PDF
  const out = kit.pdf ? { pngs: layoutPngs_(kit.slides.map((x, i) => kitCardLayout_(kit, i)), names), pdf: null } : layoutDeck_(kit.slides.map((x, i) => kitCardLayout_(kit, i)), (pid, slides) => ({
    pngs: slides.map((id, i) => {
      const th = slidesApi_('get', '/' + pid + '/pages/' + id + '/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE');
      return UrlFetchApp.fetch(th.contentUrl).getBlob().setName('名單包_' + kit.series + '_' + stamp + '_' + (i + 1) + '.png');
    }),
    pdf: UrlFetchApp.fetch('https://docs.google.com/presentation/d/' + pid + '/export/pdf', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName('《' + kit.series + '》（' + kit.keyword + '）.pdf'),
  })) || { pngs: [], pdf: null };
  if (kit.pdf) out.pdf = layoutPdf_(kitPdfLayouts_(kit), pdfName) || null;
  const pngs = out.pngs, pdf = out.pdf;
  let pdfUrl = '', files = [];
  try {
    const it = DriveApp.getFoldersByName(KIT_FOLDER);
    const dir = it.hasNext() ? it.next() : DriveApp.createFolder(KIT_FOLDER);
    files = pngs.map(png => dir.createFile(png.copyBlob().setName(png.getName())));
    if (pdf) {
      const f = dir.createFile(pdf);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      pdfUrl = 'https://drive.google.com/file/d/' + f.getId() + '/view';
    }
  } catch (e) { console.error('名單包存檔失敗：' + e.message); }
  igRemember_(files, stratHead_() + '｜' + kit.cat2 + '\n\n' + postText_(kit));
  return { pngs: pngs, files: files, pdf: pdf, pdfUrl: pdfUrl, err: pngs.length && pdf ? '' : REPORT_ERR_ || '簡報畫圖失敗' };
}
function kitDoneText_(kit, r) {
  return ['📕 《' + kit.series + '》做好了', '',
    r.pngs.length ? '🖼️ 7 張輪播圖卡：長按存到相簿，照順序發 IG。' : '🖼️ 圖卡這次沒畫出來：' + r.err,
    r.pdfUrl ? '📄 PDF：' + r.pdfUrl + '\n有人留言「' + kit.keyword + '」，就把這個連結傳給他。' : '📄 PDF 這次沒做出來：' + r.err].join('\n');
}

// 按了主題後真正開始做：寫內容（AI）→ 交給各平台畫圖、送出；寫失敗就回錯誤訊息
function kitRun_(deliver) {
  const k = KIT_PENDING_.split('|'); KIT_PENDING_ = '';
  if (!k[0]) return null;
  try {
    const w = kitWrite_(k[0]);
    if (!LAST_KIT_) return w;
    LAST_KIT_.style = k[1] || '';
    logChat_('assistant', String(w.text || w).slice(0, 2000));
    deliver();
    return null;
  } finally { busyEnd_('KIT_BUSY'); }
}
// LINE／Telegram：按了主題先回「製作中」，真正的製作交給另一次執行（觸發條件），
// 不跟收訊息擠同一次執行的 6 分鐘上限；被中斷時，每 5 分鐘的提醒檢查會補發通知
function kitQueue_(platform, to) {
  const job = { k: KIT_PENDING_, p: platform, to: String(to), at: Date.now() };
  KIT_PENDING_ = '';
  if (!job.k) return;
  setProp_('KIT_JOB', JSON.stringify(job));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'kitJob').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kitJob').timeBased().after(1000).create();
}
function kitJob() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'kitJob').forEach(t => ScriptApp.deleteTrigger(t));
  let job = null;
  try { job = JSON.parse(prop_('KIT_JOB') || 'null'); } catch (e) { job = null; }
  setProp_('KIT_JOB', '');
  if (!job || !job.k) return;
  setProp_('KIT_RUN', JSON.stringify({ p: job.p, to: job.to, at: Date.now() }));
  const tell = (text, buttons) => job.p === 'line'
    ? lineApi_('push', { to: job.to, messages: withQuick_([{ type: 'text', text: text }], buttons || [[KIT_BTN]]) })
    : tgSend_(job.to, { text: text, buttons: buttons || [[KIT_BTN]] });
  try {
    if (job.p === 'line') { LINE_MODE_ = true; CURRENT_TG_CHAT_ = ''; } else { LINE_MODE_ = false; CURRENT_TG_CHAT_ = job.to; }
    KIT_PENDING_ = job.k;
    const fail = kitRun_(() => job.p === 'line' ? kitLine_(job.to) : kitTg_(job.to));
    if (fail) tell(String(fail.text || fail), fail.buttons);
  } catch (err) {
    console.error('7張＋PDF 失敗：' + err.message);
    tell('📕 這次沒做出來（' + String(err.message).slice(0, 120) + '），再按一次試試看。');
  } finally {
    setProp_('KIT_RUN', '');
  }
}
// 做到一半被系統中斷（超過 6 分鐘）就不會有任何回覆：提醒檢查時發現就補一則通知
function kitWatch_() {
  let run = null;
  try { run = JSON.parse(prop_('KIT_RUN') || 'null'); } catch (e) { run = null; }
  if (!run || Date.now() - run.at < 7 * 60 * 1000) return;
  setProp_('KIT_RUN', '');
  const text = '📕 剛剛的 7張＋PDF 做太久被系統中斷了，沒有做出來。請再按一次主題試試看。';
  if (run.p === 'line') lineApi_('push', { to: run.to, messages: [{ type: 'text', text: text }] });
  else tgSend_(run.to, text);
}
// LINE：按下去先回「製作中」，做好再推播（圖卡、文案、PDF 連結），避免回覆逾時
function kitLine_(to) {
  const kit = LAST_KIT_; LAST_KIT_ = null;
  if (!kit) return;
  const r = kitMake_(kit);
  const imgs = r.files.map(f => {
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const url = 'https://lh3.googleusercontent.com/d/' + f.getId();
    return { type: 'image', originalContentUrl: url, previewImageUrl: url };
  });
  const send = msgs => lineApi_('push', { to: to, messages: msgs });
  let code = imgs.length ? send(imgs.slice(0, 5)) : 200;
  if (code === 200) code = send(withQuick_(imgs.slice(5).concat([{ type: 'text', text: (stratHead_() + '｜' + kit.cat2 + '\n\n' + postText_(kit)).slice(0, 5000) },
    { type: 'text', text: kitDoneText_(kit, r) }]).slice(0, 5), [[KIT_BTN, STRAT_SWITCH]].concat(igReady_() ? [[IG_BTN]] : [], MENU)));
  if (code !== 200) kitLineFallback_(kit, r, code);
}
// LINE 推播送不出去（最常見是免費方案每月推播則數用完，LINE 回 429）：改傳到 Telegram，並說明原因
function kitLineFallback_(kit, r, code) {
  const why = code === 429 ? 'LINE 這個月的推播則數用完了' : 'LINE 推播失敗（' + code + '）';
  const tg = prop_('TG_OWNER_CHAT_ID');
  if (!tg) return;
  LINE_MODE_ = false; CURRENT_TG_CHAT_ = tg;
  tgSend_(tg, '📕 ' + why + '，名單包改傳到這裡。');
  kitTgSend_(tg, kit, r);
}
// Telegram：7 張一組相簿＋PDF 檔
function kitTg_(chatId) {
  const kit = LAST_KIT_; LAST_KIT_ = null;
  if (!kit) return false;
  tgApi_('sendChatAction', { chat_id: chatId, action: 'upload_photo' });
  kitTgSend_(chatId, kit, kitMake_(kit));
  return true;
}
function kitTgSend_(chatId, kit, r) {
  if (r.pngs.length) {
    const payload = { chat_id: String(chatId), media: JSON.stringify(r.pngs.map((p, i) => ({ type: 'photo', media: 'attach://p' + i, caption: i ? '' : '📕 《' + kit.series + '》' }))) };
    r.pngs.forEach((p, i) => { payload['p' + i] = p; });
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/sendMediaGroup', { method: 'post', muteHttpExceptions: true, payload: payload });
    if (res.getResponseCode() !== 200) console.error('Telegram 7 張圖卡失敗：' + res.getContentText());
  }
  if (r.pdf) {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/sendDocument', { method: 'post', muteHttpExceptions: true,
      payload: { chat_id: String(chatId), document: r.pdf, caption: '有人留言「' + kit.keyword + '」，把這份 PDF 轉給他。' } });
    if (res.getResponseCode() !== 200) console.error('Telegram PDF 失敗：' + res.getContentText());
  }
  tgSend_(chatId, { text: (stratHead_() + '｜' + kit.cat2 + '\n\n' + postText_(kit)).slice(0, 4000) });
  tgSend_(chatId, { text: kitDoneText_(kit, r), buttons: [[KIT_BTN, STRAT_SWITCH]].concat(igReady_() ? [[IG_BTN]] : [], MENU) });
}
// 對話頁：7 張圖直接顯示，PDF 給連結
function kitTalk_() {
  const kit = LAST_KIT_; LAST_KIT_ = null;
  if (!kit) return '';
  const r = kitMake_(kit);
  ASK_IMGS_ = r.pngs.map(png => 'data:image/png;base64,' + Utilities.base64Encode(png.getBytes()));
  ASK_SHOW_ = stratHead_() + '｜' + kit.cat2 + '\n\n' + postText_(kit) + '\n\n' + kitDoneText_(kit, r);
  return ASK_IMGS_[0] || '';
}

/* ============ 案例庫（Telegram 圖片／影片／文字） ============ */
// Telegram 機器人看不到你以前的聊天紀錄，所以案例要「轉傳給小乖」才會進案例庫；
// 存的是 Telegram 的 file_id（檔案還是在 Telegram 上），找到時小乖直接把原圖／原影片再傳給你
const CASE_SHEET = '案例庫';
const CASE_CAT_SHEET = '案例分類';
// 預設分類；之後可以直接改試算表「案例分類」分頁（一列一個），或打「改分類 新名字」新增
const CASE_CATS = ['見證案例', '使用前後對比', '產品介紹', '試算報表', '課程活動', '其他'];
const CASE_HEAD = ['時間', '分類', '類型', '產品', '人物', '說明文字', 'AI 摘要', '關鍵字', '來源', 'file_id', '雲端硬碟'];
const CASE_ICON = { photo: '🖼️', video: '🎬', animation: '🎞️', document: '📄', text: '📝' };
let CURRENT_TG_CHAT_ = '';
let IMG_NOT_ORDER_ = false;   // 沒寫說明的圖片看起來不是訂單／明細表

function caseSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(CASE_SHEET);
  if (sh && sh.getLastRow() >= 1 && sh.getRange(1, 2).getValue() !== '分類') {
    sh.setName(CASE_SHEET + '（舊）');   // 舊格式先改名保留，資料下面會搬過來
    sh = null;
  }
  if (!sh) {
    sh = ss.insertSheet(CASE_SHEET);
    sh.appendRow(CASE_HEAD);
    sh.setFrozenRows(1);
  }
  if (sh.getRange(1, 11).getValue() !== '雲端硬碟') sh.getRange(1, 11).setValue('雲端硬碟');   // 舊表補上欄位
  migrateOldCases_(ss, sh);
  newestFirst_(sh, CASE_HEAD.length);
  return sh;
}

// 舊版案例庫（時間｜類型｜file_id｜說明文字｜AI 描述｜來源）搬進新的案例庫，只搬一次
function migrateOldCases_(ss, sh) {
  if (prop_('CASE_OLD_MIGRATED')) return;
  const old = ss.getSheetByName(CASE_SHEET + '（舊）');
  if (old && old.getLastRow() > 1) {
    const have = {};
    if (sh.getLastRow() > 1) sh.getRange(2, 10, sh.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0]) have[r[0]] = 1; });
    const rows = old.getRange(2, 1, old.getLastRow() - 1, 6).getValues()
      .filter(r => (r[2] || r[3]) && !(r[2] && have[r[2]]))
      .map(r => [r[0], '其他', String(r[1] || 'photo'), '', '', String(r[3] || ''), String(r[4] || '').slice(0, 300), '', String(r[5] || ''), String(r[2] || '')])
      .sort((a, b) => (b[0] instanceof Date ? b[0].getTime() : 0) - (a[0] instanceof Date ? a[0].getTime() : 0));
    if (rows.length) {
      const last = sh.getLastRow();
      sh.getRange(last + 1, 1, rows.length, CASE_HEAD.length).setValues(rows);   // 舊的接在最下面
    }
  }
  setProp_('CASE_OLD_MIGRATED', '1');
}

function caseCats_() {
  const ss = ss_();
  let sh = ss.getSheetByName(CASE_CAT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CASE_CAT_SHEET);
    sh.appendRow(['分類（一列一個，可以自己改）']);
    CASE_CATS.forEach(c => sh.appendRow([c]));
  }
  const n = sh.getLastRow() - 1;
  const cats = [];
  (n > 0 ? sh.getRange(2, 1, n, 1).getValues() : []).forEach(r => {
    const c = String(r[0]).replace(/^🗂️\s*/, '').trim();
    if (c && cats.indexOf(c) < 0) cats.push(c);   // 重複的只算一次
  });
  if (!cats.length) CASE_CATS.forEach(c => cats.push(c));
  if (cats.indexOf('其他') < 0) cats.push('其他');   // 一定留「其他」接沒地方放的案例
  syncCaseCats_(cats);
  return cats;
}

// 「案例分類」分頁改過時，案例跟著改：同一列換了名字＝改名；被刪掉的分類，裡面的案例移到「其他」
function syncCaseCats_(cats) {
  const key = JSON.stringify(cats);
  const prevRaw = prop_('CASE_CATS_PREV');
  if (prevRaw === key) return;
  let prev = [];
  try { prev = JSON.parse(prevRaw || '[]'); } catch (e) { prev = []; }
  const map = {};
  prev.forEach((p, i) => {
    if (cats.indexOf(p) >= 0) return;
    map[p] = (i < cats.length && prev.indexOf(cats[i]) < 0) ? cats[i] : '其他';
  });
  const sh = ss_().getSheetByName(CASE_SHEET);
  if (sh && sh.getLastRow() > 1 && sh.getRange(1, 2).getValue() === '分類') {
    const rng = sh.getRange(2, 2, sh.getLastRow() - 1, 1);
    let changed = false;
    const vals = rng.getValues().map(r => {
      const c = String(r[0] || '').trim();
      const to = c === TEXT_CAT ? c : map[c] || (cats.indexOf(c) < 0 ? '其他' : c);
      if (to !== r[0]) changed = true;
      return [to];
    });
    if (changed) rng.setValues(vals);
  }
  setProp_('CASE_CATS_PREV', key);
}

function writeCaseCats_(cats) {
  const sh = ss_().getSheetByName(CASE_CAT_SHEET);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).clearContent();
  sh.getRange(2, 1, cats.length, 1).setValues(cats.map(c => [c]));
}

// 「新增分類 X」「分類改名 舊 新」「刪除分類 X」：分類表和案例一起改，不會留下舊的
function editCaseCat_(op, a, b) {
  const cats = caseCats_();
  if (op === 'add') {
    if (cats.indexOf(a) >= 0) return '【' + a + '】已經有了。';
    cats.splice(Math.max(0, cats.indexOf('其他')), 0, a);
    writeCaseCats_(cats); syncCaseCats_(cats);
    return '✅ 已新增分類【' + a + '】';
  }
  if (cats.indexOf(a) < 0) return '沒有【' + a + '】這個分類。現在的分類：' + cats.join('、');
  if (op === 'rename') {
    if (cats.indexOf(b) >= 0) return mergeCaseCat_(cats, a, b);
    cats[cats.indexOf(a)] = b;
    writeCaseCats_(cats); syncCaseCats_(cats);
    return '✅ 【' + a + '】已改名成【' + b + '】，裡面的案例也一起改了。';
  }
  if (a === '其他') return '「其他」要留著放沒分到的案例，不能刪喔。';
  return mergeCaseCat_(cats, a, '其他', '🗑️ 已刪除分類【' + a + '】，裡面的案例移到【其他】。');
}

function mergeCaseCat_(cats, from, to, msg) {
  const rest = cats.filter(c => c !== from);
  const sh = ss_().getSheetByName(CASE_SHEET);
  if (sh && sh.getLastRow() > 1) {
    const rng = sh.getRange(2, 2, sh.getLastRow() - 1, 1);
    rng.setValues(rng.getValues().map(r => [String(r[0]).trim() === from ? to : r[0]]));
  }
  writeCaseCats_(rest);
  setProp_('CASE_CATS_PREV', JSON.stringify(rest));
  return msg || '✅ 【' + from + '】已併進【' + to + '】。';
}

// 請 AI 分類並整理：分類、產品編號、人物、一句摘要、關鍵字（圖片用 low 解析度，便宜）
function classifyCase_(type, text, imageUrl, cats) {
  const sys = '你幫使用者整理「案例庫」，讓資料多了也好找。只輸出 JSON：'
    + '{"category":"","products":[],"people":[],"summary":"","keywords":[]}。'
    + 'category 只能從這些挑一個：' + cats.join('、') + '。'
    + 'products 是看得到的產品編號或品名（例如 211、777Q、2711AB、火山甘露）；people 是人名或稱呼（例如 張小姐）；'
    + 'summary 用繁體中文一句話（30 字內）說這是什麼；keywords 5～8 個，方便日後搜尋。看不出來的留空，不要編。';
  const parts = [{ type: 'text', text: '類型：' + type + (text ? '\n內容／說明：' + text : '') }];
  if (imageUrl) parts.push({ type: 'image_url', image_url: { url: imageUrl, detail: 'low' } });
  const raw = callOpenAI_(sys, [{ role: 'user', content: parts }], true);
  let j;
  try { j = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch (e) { j = { summary: String(raw).slice(0, 60) }; }
  if (cats.indexOf(j.category) < 0) j.category = '其他';
  ['products', 'people', 'keywords'].forEach(k => { if (!Array.isArray(j[k])) j[k] = []; });
  j.summary = String(j.summary || '');
  return j;
}

function saveTgCase_(msg, photoId, video, doc, caption) {
  let type = 'text', fid = '', thumb = '';
  if (video) { type = msg.video ? 'video' : msg.animation ? 'animation' : 'document'; fid = video.file_id; thumb = (video.thumbnail || video.thumb || {}).file_id || ''; }
  else if (photoId) { type = doc ? 'document' : 'photo'; fid = photoId; thumb = photoId; }
  let text = String(caption || (type === 'text' ? msg.text || '' : '')).trim();
  const fname = video && video.file_name ? String(video.file_name).replace(/\.[^.]+$/, '') : '';
  if (fname && text.indexOf(fname) < 0) text = (text ? text + ' ' : '') + '〔' + fname + '〕';
  if (type === 'text' && !text) return '這則沒有內容可以存。';
  const o = msg.forward_origin || {};
  const src = (o.chat && o.chat.title) || (o.sender_user && o.sender_user.first_name) || o.sender_user_name
    || (msg.forward_from_chat && msg.forward_from_chat.title) || (msg.forward_from && msg.forward_from.first_name) || '';
  return storeCase_(type, text, fid, () => thumb ? tgImage_(thumb) : '', src);
}

// 存一筆案例：說明有「#分類」或按了「➕ 新增見證」就用那個分類，否則讓 AI 分類
function storeCase_(type, text, fid, imgFn, src, force) {
  const cats = caseCats_();
  // 說明裡寫「#見證案例」就直接用這個分類
  let forced = force || casePending_();
  const tag = text.match(/#(\S+)/);
  if (tag && cats.indexOf(tag[1]) >= 0) { forced = tag[1]; text = text.replace(tag[0], '').trim(); }
  let info = { category: forced || '其他', products: [], people: [], summary: '', keywords: [] };
  try {
    info = classifyCase_(type, text, imgFn() || '', cats);
    if (forced) info.category = forced;
  } catch (e) { console.error('案例分類失敗：' + e.message); }
  const join = a => (Array.isArray(a) ? a : []).map(String).filter(Boolean).join('、');
  if (type === 'text') info.category = TEXT_CAT;
  const row = withLock_(() => {
    const sh = caseSheet_();
    const now = new Date();
    prependRow_(sh, [now, info.category, type, join(info.products), join(info.people), text, String(info.summary || ''), join(info.keywords), src, fid]);
    return now.getTime();
  });
  setProp_('CASE_LAST_TIME', String(row));
  const NAME = { photo: '圖片', video: '影片', animation: '動圖', document: '檔案', text: '文字' };
  const tags = [join(info.products), join(info.people)].filter(Boolean).join('｜');
  if (type === 'text') return {   // 純文字固定放【文字】，不給改分類按鈕
    text: '📁 已存進【' + TEXT_CAT + '】' + (info.summary || text ? '\n' + String(info.summary || text).replace(/\s+/g, ' ').slice(0, 60) : '')
      + (tags ? '\n🏷️ ' + tags : '') + '\n要改說明按「✏️ 改說明」；不要了按「🗑️ 刪除見證」',
    buttons: [['✏️ 改說明', '🗑️ 刪除見證']],
  };
  return {
    text: '📁 已存進【' + info.category + '】（' + NAME[type] + '）'
      + (info.summary || text ? '\n' + String(info.summary || text).replace(/\s+/g, ' ').slice(0, 60) : '')
      + (tags ? '\n🏷️ ' + tags : '')
      + '\n要改說明按「✏️ 改說明」；不要了按「🗑️ 刪除見證」；分錯了按下面的分類就能改',
    buttons: [['✏️ 改說明', '🗑️ 刪除見證']].concat(chunk_(cats.filter(c => c !== info.category).map(c => '改分類 ' + c), 2).slice(0, 4)),
  };
}

function chunk_(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// 「改分類 見證案例」：改最近存的那一筆；分類不存在就新增
function recatCase_(name) {
  const t = Number(prop_('CASE_LAST_TIME'));
  const sh = ss_().getSheetByName(CASE_SHEET);
  const n = sh ? Math.min(sh.getLastRow() - 1, 50) : 0;
  const idx = n > 0 && t ? sh.getRange(2, 1, n, 1).getValues().findIndex(r => r[0] instanceof Date && r[0].getTime() === t) : -1;
  if (idx < 0) return '找不到剛剛存的案例。';
  const cats = caseCats_();
  if (cats.indexOf(name) < 0) return { text: '沒有【' + name + '】這個分類，選一個現有的；要新的分類請打「新增分類 ' + name + '」。', buttons: chunk_(cats.map(c => '改分類 ' + c), 2).slice(0, 5) };
  sh.getRange(idx + 2, 2).setValue(name);
  return '✅ 已改成【' + name + '】';
}

// 「➕ 新增見證」按下後 10 分鐘內傳的圖片、影片都存成這個分類
// LINE 沒按試算就傳的圖片：給這三個選擇
const LINE_IMG_BTNS = [['📋 試算這張', '💬 存成見證'], ['🖼️ 看圖說明']];
function lineImgPick_(flat) {
  const m = flat.match(/^(試算這張|存成見證|看圖說明)$/);
  if (!m) return null;
  const v = String(prop_('LINE_LAST_IMG') || '').split('|');
  if (!v[0] || Date.now() - Number(v[1]) > 30 * 60 * 1000) return '找不到剛剛的圖片了，請再傳一次。';
  setProp_('LINE_LAST_IMG', '');
  try {
    if (m[1] === '存成見證') return saveLineCase_(v[0], 'image', caseCats_().indexOf('見證案例') >= 0 ? '見證案例' : '其他');
    return image_(m[1] === '試算這張' ? '試算' : '幫我看這張圖，說明內容', lineImage_(v[0]));
  } catch (e) { console.error(e); return '圖片讀取失敗（LINE 的圖片放太久會拿不到），請再傳一次。'; }
}

function casePending_() {
  return Number(prop_('CASE_UNTIL')) > Date.now() ? prop_('CASE_PENDING') || '' : '';
}

// LINE 傳來的案例圖片／影片存雲端硬碟「小乖案例庫」，設成知道連結的人都能看，LINE 才能再傳出來分享
// file_id 欄存「drive:檔案ID」（影片是「drive:影片ID|預覽圖ID」）
const CASE_FOLDER = '小乖案例庫';
function caseFolder_() {
  const it = DriveApp.getFoldersByName(CASE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CASE_FOLDER);
}
function saveLineCase_(messageId, type, forced) {
  const folder = caseFolder_();
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss');
  const put = (blob, name) => {
    const f = folder.createFile(blob.setName(name));
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return f.getId();
  };
  const blob = lineContent_(messageId);
  let fid = 'drive:' + put(blob, '案例_' + stamp + (type === 'video' ? '.mp4' : '.jpg')), img = null;
  if (type === 'video') {
    try {
      const res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content/preview', {
        headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') }, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) { img = res.getBlob(); fid += '|' + put(img.copyBlob(), '案例_' + stamp + '_預覽.jpg'); }
    } catch (e) { console.error('影片預覽圖失敗：' + e.message); }
  } else img = blob;
  return storeCase_(type === 'video' ? 'video' : 'photo', '', fid, () => img ? dataUrl_(img) : '', 'LINE', forced);
}
// Telegram 存的圖片／影片：第一次在 LINE 看時從 Telegram 下載一份放雲端硬碟（記在「雲端硬碟」欄），之後兩邊共用
function caseDrive_(c) {
  if (/^drive:/.test(c.fid)) return c.fid;
  if (c.drive) return c.drive;
  if (!c.fid || ['photo', 'video', 'animation'].indexOf(c.type) < 0) return '';
  try {
    const info = JSON.parse(tgApi_('getFile', { file_id: c.fid }));
    if (!info.ok) return '';   // Telegram 只能下載 20MB 以內的檔案
    const res = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/' + info.result.file_path, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    const ext = c.type === 'photo' ? '.jpg' : '.mp4';
    const f = caseFolder_().createFile(res.getBlob().setName('案例_TG_' + Utilities.formatDate(new Date(c.time || Date.now()), TZ, 'yyyyMMdd_HHmmss') + ext));
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    c.drive = 'drive:' + f.getId();
    setCaseCol_(c, 11, c.drive);
    return c.drive;
  } catch (e) { console.error('Telegram 案例複製到雲端硬碟失敗：' + e.message); return ''; }
}
const driveIds_ = fid => String(fid).slice(6).split('|');
const driveImg_ = id => 'https://lh3.googleusercontent.com/d/' + id;
const driveFile_ = id => 'https://drive.usercontent.google.com/download?id=' + id + '&export=download';
// 瀏覽案例時，雲端硬碟裡的圖片／影片在 LINE 直接傳出來（一次最多 4 個）
let CASE_LINE_ = [];
// 對話頁：案例做成卡片（縮圖可點開原檔＋說明＋分享到 LINE），不要只丟一串點不了的網址（使用者 2026-10-16）
let TALK_CASES_ = [];
function talkCase_(c, d) {
  const ids = d ? driveIds_(d) : [];
  const KIND = { photo: '圖片', video: '影片', animation: '動圖', document: '檔案', text: '文字' };
  return { k: caseKey_(c), type: c.type, kind: KIND[c.type] || '', cat: c.type === 'text' ? TEXT_CAT : c.cat,
    day: c.time instanceof Date ? Utilities.formatDate(c.time, TZ, 'M/d') : '',
    cap: String(c.summary || c.text || '').replace(/\s+/g, ' ').slice(0, 120), text: String(c.text || c.summary || '').trim().slice(0, 500),
    tags: [c.products, c.people].filter(Boolean).join('｜'),
    thumb: !ids.length ? '' : c.type === 'photo' ? driveImg_(ids[0]) : ids[1] ? driveImg_(ids[1]) : 'https://drive.google.com/thumbnail?id=' + ids[0] + '&sz=w480',
    link: ids.length ? 'https://drive.google.com/file/d/' + ids[0] + '/view' : '' };
}
function caseStars_() { try { return JSON.parse(prop_('CASE_STARS') || '[]'); } catch (e) { return []; } }
function wallApi_(b) {
  if (b.action === 'caseStar') {
    const st = caseStars_().filter(k => k !== String(b.k));
    if (b.on) st.unshift(String(b.k));
    setProp_('CASE_STARS', JSON.stringify(st.slice(0, 200)));
    return { ok: true };
  }
  const list = allCases_(), stars = caseStars_();
  if (b.action === 'caseDel') {   // 見證庫打勾多筆刪除（頁面上先確認過）
    const ks = [].concat(b.ks || []).map(String);
    const pick = list.filter(c => ks.indexOf(String(caseKey_(c))) >= 0).sort((x, y) => y.row - x.row);   // 從下面刪，列號才不會亂
    const n = withLock_(() => {
      const sh = ss_().getSheetByName(CASE_SHEET);
      let k = 0;
      pick.forEach(c => {
        const cell = sh && c.row && sh.getRange(c.row, 1).getValue();
        if (cell instanceof Date && c.time instanceof Date && cell.getTime() === c.time.getTime()) { sh.deleteRow(c.row); k++; }
      });
      return k;
    });
    pick.forEach(c => [c.fid, c.drive].filter(x => /^drive:/.test(x)).forEach(d => driveIds_(d).forEach(id => {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}   // 30 天內還能從垃圾桶救回
    })));
    const gone = pick.map(c => String(caseKey_(c)));
    setProp_('CASE_STARS', JSON.stringify(stars.filter(k => gone.indexOf(k) < 0)));
    return { ok: true, n: n };
  }
  if (b.action === 'caseLink') {   // 還沒放進雲端硬碟的 Telegram 檔案：現在複製；超過 20MB 就改傳到主人的 Telegram
    const c = list.find(x => String(caseKey_(x)) === String(b.k));
    if (!c) return { ok: false, error: '找不到這一則了，可能已經刪掉。' };
    const d = caseDrive_(c);
    if (d) return { ok: true, item: talkCase_(c, d) };
    const tg = prop_('TG_OWNER_CHAT_ID');
    if (tg && prop_('TELEGRAM_BOT_TOKEN')) {
      try { if (JSON.parse(sendTgCase_(tg, c) || '{}').ok) return { ok: true, tg: true }; } catch (e) { console.error(e.message); }
    }
    return { ok: false, error: '這個檔案超過 20MB，沒辦法做成連結，Telegram 也沒送成功。' };
  }
  const items = list.map(c => {
    const media = ['photo', 'video', 'animation'].indexOf(c.type) >= 0, d = /^drive:/.test(c.fid) ? c.fid : c.drive;
    const it = talkCase_(c, media && d ? d : '');
    it.star = stars.indexOf(String(it.k)) >= 0;
    it.t = c.time instanceof Date ? c.time.getTime() : 0;
    it.products = c.products; it.people = c.people; it.kw = c.keywords;
    it.need = media && !d;   // 要先按一下才產生連結
    return it;
  });
  return { ok: true, items: items, cats: caseCats_() };
}
function caseLine_() { const m = CASE_LINE_; CASE_LINE_ = []; return m; }
function lineCaseMsg_(c, d) {
  const ids = driveIds_(d);
  if (c.type !== 'photo') return { type: 'video', originalContentUrl: driveFile_(ids[0]),
    previewImageUrl: ids[1] ? driveImg_(ids[1]) : 'https://yb131419.github.io/Tezhu/xiaoguai.jpg' };   // 沒有預覽圖就用小乖頭像
  return { type: 'image', originalContentUrl: driveImg_(ids[0]), previewImageUrl: driveImg_(ids[0]) };
}

function allCases_() {
  caseCats_();               // 分類表改過的話，案例的分類先跟著改
  const sh = caseSheet_();   // 會順便把舊版案例搬過來
  if (!sh || sh.getLastRow() < 2 || sh.getRange(1, 2).getValue() !== '分類') return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, CASE_HEAD.length).getValues().map((r, i) => ({ row: i + 2, drive: String(r[10] || ''),
    time: r[0], cat: String(r[1] || '其他'), type: String(r[2]), products: String(r[3] || ''), people: String(r[4] || ''),
    text: String(r[5] || ''), summary: String(r[6] || ''), keywords: String(r[7] || ''), src: String(r[8] || ''), fid: String(r[9] || ''),
  }));   // 工作表本來就是新的在上面
}

function findCases_(words) {
  const all = allCases_().map(c => ({ c: c, s: [c.cat, c.products, c.people, c.text, c.summary, c.keywords, c.src].join(' ').toLowerCase() }));
  const exact = all.filter(x => words.every(w => x.s.indexOf(w) >= 0)).map(x => x.c);
  if (exact.length) return exact;
  // 找不到完全一樣的：把關鍵字拆成兩個字一組（中文）或整個字（英文數字），符合一半以上就算，符合越多排越前面
  const parts = [];
  words.forEach(w => {
    const segs = w.match(/[a-z0-9]+|[^a-z0-9\s]+/g) || [];
    segs.forEach(g => {
      if (/^[a-z0-9]+$/.test(g) || g.length <= 2) parts.push(g);
      else for (let i = 0; i < g.length - 1; i++) parts.push(g.slice(i, i + 2));
    });
  });
  if (!parts.length) return [];
  const need = Math.max(1, Math.ceil(parts.length / 2));
  return all.map(x => ({ c: x.c, n: parts.filter(p => x.s.indexOf(p) >= 0).length }))
    .filter(x => x.n >= need)
    .sort((a, b) => b.n - a.n)
    .map(x => x.c);
}

// 「案例分類」：列出每個分類有幾筆，按了就看那個分類
function caseCatsMenu_() {
  const cats = caseCats_(), cases = allCases_();   // 先整理分類，再數
  const count = {};
  cases.forEach(c => { const k = c.type === 'text' ? TEXT_CAT : c.cat; count[k] = (count[k] || 0) + 1; });   // 純文字自己一類「文字」（使用者 2026-10-17）
  if (cats.indexOf(TEXT_CAT) < 0) cats.push(TEXT_CAT);
  const used = cats.filter(c => count[c]);   // 沒有案例的分類不出按鈕，畫面比較乾淨
  return {
    text: '🗂️ 案例分類（共 ' + cases.length + ' 筆）\n\n' + cats.map(c => '・' + c + '：' + (count[c] || 0) + ' 筆').join('\n')
      + '\n\n按下面的分類看案例。\n整理分類：「新增分類 名稱」「分類改名 舊 新」「刪除分類 名稱」',
    buttons: chunk_(used.map(c => '🗂️ ' + c + '（' + count[c] + '）'), 2).slice(0, 5),
  };
}

// 「🔍 查詢案例」：按了問關鍵字，5 分鐘內的下一句就拿來找；也可以直接打「查詢案例 王太太」
function caseFind_(t, raw) {
  const flat = String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '');
  let q = '';
  const pend = prop_('CASE_FIND');
  if (pend) {
    setProp_('CASE_FIND', '');
    const menuWord = [].concat.apply([], MENU.concat(MENU_GROUPS, QUICK)).some(b => b.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '') === flat);
    if (Number(prop_('CASE_FIND_UNTIL')) > Date.now() && !menuWord && !/^查詢案例/.test(flat)) {
      if (/^(取消|不用|算了)$/.test(flat)) return { text: '好，不找了。', buttons: MENU };
      q = String(raw || t).trim();
    }
  }
  if (!q) {
    const m = String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().match(/^(?:查詢案例|查案例|找案例|找見證|查見證)\s*(.*)$/);
    if (!m) return null;
    q = m[1].trim();
  }
  if (!q) {
    setProp_('CASE_FIND', '1');
    setProp_('CASE_FIND_UNTIL', String(Date.now() + 5 * 60 * 1000));
    return { text: '🔍 要找什麼見證？打關鍵字就好，例如：\n王太太\n211 皮膚\n\n（產品、人名、說明裡的字都找得到；打「取消」就不找）', buttons: [['取消']] };
  }
  const words = q.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  const list = allCases_().filter(c => {
    const hay = [c.cat, c.products, c.people, c.text, c.summary, c.keywords].join(' ').toLowerCase();
    return words.every(w => hay.indexOf(w) >= 0);
  });
  if (!list.length) return { text: '🔍 找不到跟「' + q + '」有關的見證。\n換個關鍵字，或少打幾個字再試試。', buttons: [['🔍 查詢案例', '💬 見證案例']].concat(MENU) };
  return browseList_('🔍「' + q + '」', list, 1, '');
}

const TEXT_CAT = '文字';   // 純文字的見證一律放這一類，不跟圖片影片的分類混在一起
function browseCat_(cat, page) {
  const list = allCases_().filter(c => cat === TEXT_CAT ? c.type === 'text' : c.cat === cat && c.type !== 'text');
  if (!list.length) return { text: '【' + cat + '】還沒有案例。轉傳圖片、影片或文字給小乖就會存進來。', buttons: MENU };
  return browseList_('【' + cat + '】', list, page, cat);
}
// 一串案例：LINE 用卡片輪播（一頁 10 張），Telegram 列文字＋傳原檔；cat 有給才有「下一頁」
function browseList_(title, list, page, cat) {
  if (!LINE_MODE_) return { text: caseLines_(title + '共 ' + list.length + ' 筆，最新的：', list), buttons: MENU };
  // LINE：一筆一張卡片，左右滑；按「📤 分享」才把那一則的圖片／影片傳出來，畫面不會一長串
  const pages = Math.ceil(list.length / CASE_PAGE), p = Math.min(Math.max(Number(page) || 1, 1), pages);
  const part = list.slice((p - 1) * CASE_PAGE, p * CASE_PAGE);
  CASE_LINE_ = [{ type: 'flex', altText: title + '共 ' + list.length + ' 筆', contents: { type: 'carousel', contents: part.map(caseBubble_) } }];
  const next = p < pages && cat ? [['➡️ ' + cat + ' 第' + (p + 1) + '頁']] : [];
  return { text: title + '共 ' + list.length + ' 筆' + (pages > 1 ? (cat ? '（第 ' + p + '／' + pages + ' 頁）' : '，先列最新的 ' + CASE_PAGE + ' 筆，多打幾個關鍵字可以縮小範圍') : '')
    + '\n左右滑看，按「📤 分享」就會把那一則傳出來，長按就能轉傳。', buttons: next.concat(MENU) };
}

// LINE 案例卡片：上面縮圖、中間摘要、下面「📤 分享」
const CASE_PAGE = 10;
let LINE_MODE_ = false;
const caseKey_ = c => (c.time instanceof Date ? c.time.getTime() : 0) + String(c.fid || '').replace(/[^\w]/g, '').slice(-6);   // 同一毫秒存的也分得開
function caseBubble_(c) {
  const d = ['photo', 'video', 'animation'].indexOf(c.type) >= 0 ? caseDrive_(c) : '';
  const ids = d ? driveIds_(d) : [];
  const img = !d ? '' : c.type === 'photo' ? driveImg_(ids[0]) : ids[1] ? driveImg_(ids[1]) : 'https://yb131419.github.io/Tezhu/xiaoguai.jpg';
  const KIND = { photo: '🖼️ 圖片', video: '🎬 影片', animation: '🎞️ 動圖', document: '📄 檔案', text: '📝 文字' };
  const day = c.time instanceof Date ? Utilities.formatDate(c.time, TZ, 'M/d') : '';
  const tags = [c.products, c.people].filter(Boolean).join('｜');
  const b = {
    type: 'bubble', size: 'kilo',
    styles: { body: { backgroundColor: '#FBF8F2' }, footer: { backgroundColor: '#FBF8F2' } },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
      { type: 'text', text: [c.type === 'text' ? TEXT_CAT : c.cat, KIND[c.type] || '', day].filter(Boolean).join(' · '), size: 'xxs', color: '#B08D57', weight: 'bold' },
      { type: 'text', text: String(c.summary || c.text || '（沒有說明）').replace(/\s+/g, ' ').slice(0, 80), size: 'sm', weight: 'bold', color: '#2A2118', wrap: true, maxLines: 3 },
    ].concat(tags ? [{ type: 'text', text: '🏷️ ' + tags, size: 'xxs', color: '#9A8B74', wrap: true, maxLines: 2 }] : []) },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px', paddingTop: '0px', contents: [{
      type: 'box', layout: 'horizontal', justifyContent: 'center', paddingAll: '10px', cornerRadius: '10px', flex: 1,
      background: { type: 'linearGradient', angle: '120deg', startColor: '#E9D3A2', endColor: '#C9A56A' },
      action: { type: 'message', label: '分享', text: '📤 分享案例 ' + caseKey_(c) },
      contents: [{ type: 'text', text: '📤 分享', size: 'sm', weight: 'bold', color: '#2A2118', flex: 0 }] }, {
      type: 'box', layout: 'horizontal', justifyContent: 'center', paddingAll: '10px', cornerRadius: '10px', flex: 1,
      borderWidth: '1px', borderColor: '#E8DCC4', backgroundColor: '#FFFFFF',
      action: { type: 'message', label: '改說明', text: '✏️ 改說明 ' + caseKey_(c) },
      contents: [{ type: 'text', text: '✏️ 說明', size: 'sm', color: '#2A2118', flex: 0 }] }, {
      type: 'box', layout: 'horizontal', justifyContent: 'center', paddingAll: '10px', cornerRadius: '10px', flex: 1,
      borderWidth: '1px', borderColor: '#E8DCC4', backgroundColor: '#FFFFFF',
      action: { type: 'message', label: '刪除', text: '🗑️ 刪除見證 ' + caseKey_(c) },
      contents: [{ type: 'text', text: '🗑️ 刪除', size: 'sm', color: '#9A5B4A', flex: 0 }] }] },
  };
  if (img) b.hero = { type: 'image', url: img, size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
    action: { type: 'uri', label: '看原檔', uri: 'https://drive.google.com/file/d/' + ids[0] + '/view' } };
  return b;
}
// 「✏️ 改說明」（剛存的那一則）或「✏️ 改說明 代號」（卡片上的那一則）：下一句就是新的說明
function caseEdit_(t, raw) {
  const flat = String(t || '').replace(/\s+/g, '');
  const pend = prop_('CASE_EDIT');
  if (pend) {
    setProp_('CASE_EDIT', '');
    const menuWord = [].concat.apply([], MENU.concat(MENU_GROUPS, QUICK)).some(b => b.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '') === flat);
    if (Number(prop_('CASE_EDIT_UNTIL')) > Date.now() && !menuWord && !/^改說明/.test(flat)) {
      if (/^(取消|不改|算了)$/.test(flat)) return { text: '好，不改。', buttons: MENU };
      const c = allCases_().find(x => caseKey_(x) === pend);
      if (!c) return '找不到這一則了，可能已經刪掉。';
      const v = String(raw || t).trim().slice(0, 500);
      setCaseCol_(c, 6, v); setCaseCol_(c, 7, v.replace(/\s+/g, ' ').slice(0, 60));
      return { text: '✅ 說明改好了：\n' + v, buttons: [['💬 見證案例']].concat(MENU) };
    }
  }
  const m = flat.match(/^改說明(\w*)$/);
  if (!m) return null;
  const list = allCases_();
  const last = Number(prop_('CASE_LAST_TIME'));
  const c = m[1] ? list.find(x => caseKey_(x) === m[1]) : list.find(x => x.time instanceof Date && x.time.getTime() === last);
  if (!c) return '找不到要改的那一則。';
  setProp_('CASE_EDIT', caseKey_(c));
  setProp_('CASE_EDIT_UNTIL', String(Date.now() + 5 * 60 * 1000));
  return { text: '✏️ 請打這一則的新說明（可以分好幾行）。\n\n目前是：\n' + (c.text || c.summary || '（沒有說明）') + '\n\n（打「取消」就不改）', buttons: [['取消']] };
}

// 「🗑️ 刪除見證」（剛存的那一則）或「🗑️ 刪除見證 代號」（卡片上的那一則）：先問，按「確定刪除」才刪
function caseDel_(t) {
  const flat = String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '');
  if (/^不刪了?$/.test(flat)) return { text: '好，留著。', buttons: [['💬 見證案例']].concat(MENU) };
  const ok = flat.match(/^確定刪除(\w+)$/);
  const m = ok || flat.match(/^刪除(?:見證|案例|這則)(\w*)$/);
  if (!m) return null;
  const list = allCases_();
  const last = Number(prop_('CASE_LAST_TIME'));
  const c = m[1] ? list.find(x => caseKey_(x) === m[1]) : list.find(x => x.time instanceof Date && x.time.getTime() === last);
  if (!c) return '找不到這一則了，可能已經刪掉。';
  const words = String(c.summary || c.text || '（沒有說明）').replace(/\s+/g, ' ').slice(0, 60);
  const NAME = { photo: '圖片', video: '影片', animation: '動圖', document: '檔案', text: '文字' };
  if (!ok) return { text: '🗑️ 要刪掉這一則' + (NAME[c.type] || '') + '嗎？\n' + words + '\n\n刪掉後就找不回來。',
    buttons: [['🗑️ 確定刪除 ' + caseKey_(c)], ['↩️ 不刪了']] };
  const done = withLock_(() => {
    const sh = ss_().getSheetByName(CASE_SHEET), cell = sh && c.row && sh.getRange(c.row, 1).getValue();
    if (!(cell instanceof Date) || cell.getTime() !== c.time.getTime()) return false;
    sh.deleteRow(c.row);
    return true;
  });
  if (!done) return '這一則剛好有變動，請再按一次「💬 見證案例」重新找。';
  // 小乖自己放在雲端硬碟的檔案一起丟到垃圾桶（30 天內還能從垃圾桶救回）
  [c.fid, c.drive].filter(x => /^drive:/.test(x)).forEach(d => driveIds_(d).forEach(id => {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  }));
  return { text: '🗑️ 已刪除：' + words, buttons: [['💬 見證案例']].concat(MENU) };
}

// 「📤 分享案例 時間」：把那一則單獨傳出來（LINE 傳圖片／影片，Telegram 傳原檔），長按就能轉傳
function shareCase_(key) {
  const c = allCases_().find(x => String(caseKey_(x)) === String(key));
  if (!c) return '找不到這一則了，可能已經刪掉。';
  const words = String(c.text || c.summary || '').trim();
  if (c.type === 'text') return words || '（這則沒有內容）';
  if (CURRENT_TG_CHAT_) { sendTgCase_(CURRENT_TG_CHAT_, c); return '📤 已傳在上面，長按就能轉傳。'; }
  const d = caseDrive_(c);
  if (!d) {   // 超過 20MB：Telegram 不讓機器人下載，LINE 拿不到 → 直接傳到主人的 Telegram（使用者 2026-10-16：太大也沒連結）
    const tg = prop_('TG_OWNER_CHAT_ID');
    if (tg && prop_('TELEGRAM_BOT_TOKEN')) {
      try {
        const r = JSON.parse(sendTgCase_(tg, c) || '{}');
        if (r.ok) return '📤 這支' + (c.type === 'photo' ? '圖片' : '影片') + '超過 20MB，LINE 傳不了，已經傳到你的 Telegram 小乖了。\n\n打開 Telegram → 長按這支' + (c.type === 'photo' ? '圖片' : '影片')
          + ' →「分享」就能轉到 LINE，或「存到相簿」再從 LINE 傳。' + (words ? '\n\n' + words : '');
      } catch (e) { console.error('大檔改傳 Telegram 失敗：' + e.message); }
    }
    return '這個檔案超過 20MB，LINE 傳不了，Telegram 也沒送成功。請到 Telegram 跟小乖說「見證案例」找這一則，長按就能分享。';
  }
  if (TALK_MODE_) { TALK_CASES_ = [talkCase_(c, d)]; return '① 按「看' + (c.type === 'photo' ? '圖片' : '影片') + '」確認內容\n② 按「分享到 LINE」\n③ 選要傳給誰，按「傳送」'; }
  CASE_LINE_ = [lineCaseMsg_(c, d)];
  return '📤 長按上面的' + (c.type === 'photo' ? '圖片' : '影片') + '就能轉傳。'
    + (c.type !== 'photo' ? '\n（影片打不開就點：https://drive.google.com/file/d/' + driveIds_(d)[0] + '/view ）' : '')
    + (words ? '\n\n' + words : '');
}

// 列出案例（每筆一行：圖示＋摘要＋標籤），圖片／影片在 Telegram 另外傳原檔
function caseLines_(title, list) {
  if (TALK_MODE_ && !CURRENT_TG_CHAT_) {   // 對話頁：一則一張卡片
    let dl = 0;
    TALK_CASES_ = list.slice(0, 10).map(c => {
      const media = ['photo', 'video', 'animation'].indexOf(c.type) >= 0;
      const has = /^drive:/.test(c.fid) || c.drive;
      return talkCase_(c, media && (has || dl++ < 4) ? caseDrive_(c) : '');
    });
    return title + (list.length > 10 ? '\n（先列最新 10 筆，還有 ' + (list.length - 10) + ' 筆，多打幾個關鍵字可以縮小範圍）' : '')
      + '\n分享步驟：\n① 按「看影片／看圖片」確認內容\n② 按「分享到 LINE」\n③ 選要傳給誰，按「傳送」';
  }
  const out = [title];
  list.slice(0, 10).forEach(c => {
    const tags = [c.products, c.people].filter(Boolean).join('｜');
    out.push(CASE_ICON[c.type] + ' ' + String(c.summary || c.text).replace(/\s+/g, ' ').slice(0, 40) + (tags ? '（' + tags + '）' : ''));
  });
  if (list.length > 10) out.push('…還有 ' + (list.length - 10) + ' 筆，多打幾個關鍵字可以縮小範圍');
  const media = list.filter(c => c.type !== 'text' && c.fid);
  if (media.length) {
    if (CURRENT_TG_CHAT_) { media.slice(0, 5).forEach(c => sendTgCase_(CURRENT_TG_CHAT_, c)); out.push('（最新 ' + Math.min(5, media.length) + ' 個圖片／影片已傳在上面）'); }
    else {
      const drv = media.filter(c => c.type !== 'document').slice(0, 4).map(c => ({ c: c, d: caseDrive_(c) })).filter(x => x.d);
      CASE_LINE_ = drv.map(x => lineCaseMsg_(x.c, x.d));
      if (CASE_LINE_.length) out.push('（最新 ' + CASE_LINE_.length + ' 個圖片／影片在上面，長按就能轉傳分享）');
      drv.filter(x => x.c.type !== 'photo').forEach(x => out.push('🎬 影片連結：https://drive.google.com/file/d/' + driveIds_(x.d)[0] + '/view'));
      if (media.length > drv.length && !drv.length) out.push('（這些圖片／影片超過 20MB，LINE 傳不了；按「📤 分享」會改傳到你的 Telegram）');
    }
  }
  return out.join('\n');
}

function sendTgCase_(chatId, c) {
  const cap = ('【' + c.cat + '】' + (c.text || c.summary)).slice(0, 900);
  const m = { photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], animation: ['sendAnimation', 'animation'], document: ['sendDocument', 'document'] }[c.type];
  if (!m) return;
  const p = { chat_id: chatId, caption: cap };
  if (!/^drive:/.test(c.fid)) { p[m[1]] = c.fid; return tgApi_(m[0], p); }
  // LINE 存的（在雲端硬碟）：Telegram 抓不到雲端硬碟的下載網址，改成直接上傳檔案；上傳過一次就記住 Telegram 的 file_id
  if (/^tg:/.test(c.drive)) { p[m[1]] = c.drive.slice(3); return tgApi_(m[0], p); }
  const id = driveIds_(c.fid)[0];
  try {
    p[m[1]] = DriveApp.getFileById(id).getBlob();
    p.chat_id = String(chatId);
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/' + m[0], { method: 'post', payload: p, muteHttpExceptions: true });
    const j = JSON.parse(res.getContentText() || '{}');
    if (!j.ok) throw new Error(j.description || res.getResponseCode());
    const r = j.result || {};
    const fileId = r.photo ? r.photo[r.photo.length - 1].file_id : (r.video || r.animation || r.document || {}).file_id;
    if (fileId) setCaseCol_(c, 11, 'tg:' + fileId);
  } catch (e) {
    console.error('Telegram 傳雲端硬碟檔案失敗：' + e.message);   // 太大（超過 50MB）之類的：改傳連結
    tgApi_('sendMessage', { chat_id: chatId, text: cap + '\n' + (c.type === 'photo' ? '🖼️ ' : '🎬 ') + 'https://drive.google.com/file/d/' + id + '/view' });
  }
}
// 寫回案例庫某一欄（先確認那一列還是同一筆）
function setCaseCol_(c, col, val) {
  const sh = ss_().getSheetByName(CASE_SHEET), t = c.time instanceof Date ? c.time.getTime() : 0;
  const cell = sh && c.row && sh.getRange(c.row, 1).getValue();
  if (cell instanceof Date && cell.getTime() === t) sh.getRange(c.row, col).setValue(val);
}

/* ============ 找資料：先找本機（案例庫、待辦／行程／筆記），沒有才上網 ============ */
function search_(q, mode) {
  const webOnly = mode === 'web';
  logChat_('user', '找資料：' + q);
  const out = [(webOnly ? '🌐 上網找' : '📁 本機找') + '「' + q + '」'];
  let localHits = 0;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!webOnly) {
    // 1. 案例庫：文字案例直接列出，圖片／影片在 Telegram 直接傳原檔
    try {
      const cases = findCases_(words);
      if (cases.length) {
        // 依分類分段列出，每段標筆數
        const byCat = {};
        cases.forEach(c => { (byCat[c.cat] = byCat[c.cat] || []).push(c); });
        out.push('', '📁 案例庫找到 ' + cases.length + ' 筆');
        Object.keys(byCat).forEach(cat => out.push('', '【' + cat + '】' + byCat[cat].length + ' 筆',
          byCat[cat].slice(0, 5).map(c => CASE_ICON[c.type] + ' ' + String(c.summary || c.text).replace(/\s+/g, ' ').slice(0, 40)
            + ([c.products, c.people].filter(Boolean).length ? '（' + [c.products, c.people].filter(Boolean).join('｜') + '）' : '')).join('\n')
          + (byCat[cat].length > 5 ? '\n…還有 ' + (byCat[cat].length - 5) + ' 筆' : '')));
        const media = cases.filter(c => c.type !== 'text' && c.fid);
        if (media.length) {
          if (CURRENT_TG_CHAT_) { media.slice(0, 5).forEach(c => sendTgCase_(CURRENT_TG_CHAT_, c)); out.push('', '（最新 ' + Math.min(5, media.length) + ' 個圖片／影片已傳在上面）'); }
          else out.push('', '（圖片／影片存在 Telegram，到 Telegram 查就會直接傳給你）');
        }
      }
      localHits += cases.length;
    } catch (e) { console.error(e); }
    // 2. 待辦、行程、提醒、筆記
    try {
      const data = readAll_();
      const NAME = { todos: '待辦', events: '行程', reminders: '提醒', notes: '筆記' };
      const hits = [];
      COLS.forEach(c => (data[c] || []).forEach(it => {
        const s = JSON.stringify(it).toLowerCase();
        if (words.every(w => s.indexOf(w) >= 0)) hits.push('・' + NAME[c] + '：' + String(it.title || it.text || it.body || '').replace(/\s+/g, ' ').slice(0, 60));
      }));
      if (hits.length) out.push('', '📂 你存的資料', hits.slice(0, 5).join('\n') + (hits.length > 5 ? '\n…還有 ' + (hits.length - 5) + ' 筆' : ''));
      localHits += hits.length;
    } catch (e) { console.error(e); }
    // 本機只找本機；要上網按按鈕
    if (!localHits) out.push('', '📁 本機沒有找到「' + q + '」。圖片、影片、文字轉傳給小乖，就會存進案例庫。');
    const answer = out.join('\n');
    logChat_('assistant', answer.slice(0, 1000));
    return { text: answer, buttons: [['🌐 上網找 ' + q.slice(0, 14)], MENU[0], MENU[1]] };
  }
  // 3. 網路
  try {
    const web = webSearch_(q);
    out.push('', web.text);
    if (web.links.length) out.push('', '🔗 參考來源', web.links.slice(0, 4).map(l => '・' + l.title.slice(0, 30) + '\n' + l.url).join('\n'));
  } catch (err) {
    console.error(err);
    out.push('', '🌐 網路搜尋暫時失敗（' + err.message + '）');
  }
  const answer = out.join('\n');
  logChat_('assistant', answer.slice(0, 1000));
  return answer;
}

// OpenAI Responses API 的網路搜尋工具；指令碼屬性 SEARCH_MODEL 可換模型
function webSearch_(q) {
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') },
    payload: JSON.stringify({
      model: prop_('SEARCH_MODEL') || 'gpt-4.1-mini',
      tools: [{ type: 'web_search_preview', user_location: { type: 'approximate', country: 'TW' } }],
      instructions: '你是小乖，幫使用者上網找資料。用繁體中文（台灣用語）回答，先給一句結論，再條列 3～6 個重點，每點一行、簡短好懂。不要附網址（程式會另外列出來源）。',
      input: q,
    }),
  });
  const code = res.getResponseCode();
  if (code === 401) throw new Error('OpenAI 金鑰無效');
  if (code !== 200) throw new Error('搜尋回應 ' + code);
  const data = JSON.parse(res.getContentText());
  let text = '';
  const links = [], seen = {};
  (data.output || []).forEach(o => (o.type === 'message' ? o.content || [] : []).forEach(c => {
    if (c.type !== 'output_text') return;
    text += c.text || '';
    (c.annotations || []).forEach(a => {
      if (a.type === 'url_citation' && a.url && !seen[a.url]) { seen[a.url] = 1; links.push({ url: a.url.replace(/[?&]utm_source=openai$/, ''), title: a.title || a.url }); }
    });
  }));
  // 文字裡的 markdown 連結改成純文字（LINE、Telegram 都不吃 markdown）
  text = text.replace(/\(\[([^\]]+)\]\([^)]+\)\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').trim();
  return { text: text || '沒找到相關資料，換個關鍵字試試看。', links: links };
}

/* ============ 語音：轉成文字再當一般訊息處理 ============ */
// 回覆前面加上「聽到的內容」，有按鈕的回覆保留按鈕
function withVoice_(said, ans) {
  const head = '🎤 「' + said + '」\n\n';
  return typeof ans === 'object' ? { text: head + ans.text, buttons: ans.buttons } : head + ans;
}

function transcribe_(blob, filename) {
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'post', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') },
    payload: { file: blob.setName(filename), model: prop_('VOICE_MODEL') || 'whisper-1', language: 'zh', prompt: '以下是繁體中文（台灣）的語音。' },
  });
  if (res.getResponseCode() !== 200) throw new Error('語音辨識失敗（' + res.getResponseCode() + '）');
  return String(JSON.parse(res.getContentText()).text || '').trim();
}

// 語音回覆模式：auto＝你傳語音才用語音回（預設）、always＝打字也用語音回、off＝只回文字
function voiceMode_() { return prop_('VOICE_REPLY') || 'auto'; }

// 真人語音（OpenAI）：原本是 nova；2026-10-15 使用者要求換回原本，並可自由切換
const VOICES = [['nova', '原本', '明亮親切'], ['shimmer', '柔和', '輕聲細語'], ['coral', '溫暖', '溫柔有活力'], ['sage', '沉穩', '平靜成熟'], ['ash', '男聲', '穩重的男生']];
const VOICE_OK = ['nova', 'shimmer', 'coral', 'sage', 'ash', 'alloy', 'ballad', 'verse', 'fable', 'echo', 'onyx'];
function ttsVoice_() {
  if (!prop_('VOICE_RESET_V2')) { setProp_('TTS_VOICE', 'nova'); setProp_('VOICE_RESET_V2', '1'); }   // 一次性換回原本的 nova
  const v = prop_('TTS_VOICE');
  return VOICE_OK.indexOf(v) >= 0 ? v : 'nova';
}
function voicePick_(v) {
  v = String(v || '').toLowerCase();
  const btns = [VOICES.slice(0, 2), VOICES.slice(2, 4), VOICES.slice(4)].map(r => r.map(x => '🎤 ' + x[1] + ' ' + x[0]));
  const name = x => { const f = VOICES.filter(y => y[0] === x)[0]; return f ? f[1] + '（' + x + '，' + f[2] + '）' : x; };
  if (v && VOICE_OK.indexOf(v) >= 0) {
    ttsVoice_(); setProp_('TTS_VOICE', v);
    return { text: '🎤 好，小乖的聲音換成 ' + name(v) + ' 了，你聽聽看。\n\n想再換就按下面的按鈕。', buttons: btns };
  }
  return { text: '🎤 現在的聲音：' + name(ttsVoice_()) + '\n\n按下面的按鈕換聲音（換完小乖會用新聲音跟你說話）：\n'
    + VOICES.map(x => '・' + x[1] + '：' + x[2]).join('\n') + '\n\n試聽全部：https://www.openai.fm', buttons: btns };
}

function voiceSwitch_(w) {
  if (/開/.test(w)) setProp_('VOICE_REPLY', 'always');
  else if (/關/.test(w)) setProp_('VOICE_REPLY', 'off');
  else if (w === '自動') setProp_('VOICE_REPLY', 'auto');
  const m = voiceMode_();
  return '🎤 語音回覆：' + (m === 'always' ? '開（打字也用語音回）' : m === 'off' ? '關（只回文字）' : '自動（你傳語音，小乖就用語音回）')
    + '\n\n改的話打「語音回覆 開」「語音回覆 關」或「語音回覆 自動」';
}

// 把回覆變成講話的稿子：去掉表情符號、符號和網址，太長只念前面
function speechText_(ans) {
  let t = String(ans && typeof ans === 'object' ? ans.text : ans || '');
  t = t.replace(/\n?要刪掉哪一筆[^\n]*/g, '').replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*_#`>｜|【】「」]/g, ' ').replace(/[─—=]{2,}/g, ' ').replace(/^[・\-•]\s*/gm, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (t.length > 600) t = t.slice(0, 600).replace(/[^。！？\n]*$/, '') + '\n其他的請看文字。';
  return t;
}

function tts_(text, format) {
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/audio/speech', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') },
    payload: JSON.stringify({
      model: prop_('TTS_MODEL') || 'gpt-4o-mini-tts', voice: ttsVoice_(), input: text,
      instructions: ttsVoice_() === 'shimmer'
        ? '用台灣口音的中文，聲音柔和、溫柔、輕聲細語，像貼心的女生助理在身邊說話；語氣放鬆、不要太亢奮，速度稍慢一點，句子之間自然停頓。'
        : '用台灣口音的中文，語氣親切、自然、像貼心的助理，速度適中。', response_format: format || 'opus',
    }),
  });
  if (res.getResponseCode() !== 200) throw new Error('語音合成失敗（' + res.getResponseCode() + '）：' + res.getContentText().slice(0, 200));
  return res.getBlob().setName('xiaoguai.' + (format === 'mp3' ? 'mp3' : 'ogg'));
}

// LINE 的語音訊息要一個公開網址：存到雲端硬碟「小乖語音回覆」資料夾、設「知道連結的人都能看」
// （使用者 2026-10-14 打字同意「同意 LINE 語音回覆用公開連結」）；超過 2 天的舊檔自動丟垃圾桶
const VOICE_FOLDER = '小乖語音回覆';
function lineVoice_(ans) {
  const t = speechText_(ans);
  if (!t) return [];
  try {
    const it = DriveApp.getFoldersByName(VOICE_FOLDER);
    const folder = it.hasNext() ? it.next() : DriveApp.createFolder(VOICE_FOLDER);
    cleanVoice_(folder);
    const file = folder.createFile(tts_(t, 'mp3').setName('小乖語音_' + Date.now() + '.mp3'));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const ms = Math.min(600000, Math.max(1500, t.replace(/\s/g, '').length * 230 + 800));   // 中文大約一秒 4～5 個字
    return [{ type: 'audio', originalContentUrl: 'https://drive.usercontent.google.com/download?id=' + file.getId() + '&export=download', duration: ms }];
  } catch (e) { console.error('LINE 語音回覆失敗：' + e.message); return []; }
}

function cleanVoice_(folder) {
  const cut = Date.now() - 2 * 864e5, files = folder.getFiles();
  let n = 0;
  while (files.hasNext() && n < 20) {
    const f = files.next();
    if (f.getDateCreated().getTime() < cut) { f.setTrashed(true); n++; }
  }
}

// Telegram 用語音訊息回（失敗就算了，文字已經送出）
function speakTg_(chatId, ans) {
  const t = speechText_(ans);
  if (!t) return;
  try {
    tgApi_('sendChatAction', { chat_id: chatId, action: 'record_voice' });
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/sendVoice', {
      method: 'post', muteHttpExceptions: true, payload: { chat_id: String(chatId), voice: tts_(t) },
    });
    if (res.getResponseCode() !== 200) console.error('Telegram sendVoice 失敗：' + res.getContentText());
  } catch (e) { console.error(e.message); }
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
  // 一次轉傳很多張時 Telegram 會同時送來、順序不一定，所以用快取記住處理過的編號
  if (typeof CacheService !== 'undefined') {
    const cache = CacheService.getScriptCache(), k = 'tgu' + update.update_id;
    if (cache.get(k)) return;
    cache.put(k, '1', 21600);
  } else {
    const seenId = Number(prop_('TG_LAST_UPDATE_ID')) || 0;
    if (update.update_id <= seenId) return;
    setProp_('TG_LAST_UPDATE_ID', String(update.update_id));
  }

  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const owner = prop_('TG_OWNER_CHAT_ID');
  const text = String(msg.text || msg.caption || '').trim();
  const doc = msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document : null;
  const fileId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : doc && doc.file_id;
  const voice = msg.voice || msg.audio;
  CURRENT_TG_CHAT_ = chatId; LINE_MODE_ = false;

  // 發社群（IG／Threads／FB）：照片／影片說明寫「發社群」，或回覆小乖的影片、「📝 貼文文案參考」打「發社群」（要在剪 Reels 的「回覆改一版」之前判斷）
  if (owner && chatId === owner) {
    if (/^\s*設定\s*(?:IG|Instagram|Threads|脆|FB|Facebook|臉書|粉專)\s*(?:金鑰|權杖|token)\s*\S+\s*$/i.test(text)
      || /^\s*設定\s*(?:TK|TikTok|抖音)\s*(?:金鑰|權杖|key)\s*\S+\s+\S+\s*$/i.test(text)) {
      tgApi_('deleteMessage', { chat_id: chatId, message_id: msg.message_id });   // 權杖不要留在聊天紀錄
      return tgSend_(chatId, igAsk_(text, text));
    }
    const ig = igTg_(msg, text);
    if (ig) return tgSend_(chatId, ig);
  }
  // 剪 Reels：按了「🎬 剪 Reels」後傳的影片，或影片說明寫「剪 Reels」
  const reelsVideo = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (owner && chatId === owner && reelsVideo && (reelsPending_() || (REELS_WORD.test(text) && !msg.forward_origin && !msg.forward_date))) return reelsAdd_(chatId, reelsVideo, text);
  // 多支影片：傳完按「✂️ 開始剪」把收到的影片合在一起剪；「🗑️ 重選影片」清掉重來
  const rk = text.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, '');
  if (owner && chatId === owner && !reelsVideo && /^(開始剪|開始剪輯|開始剪片)$/.test(rk) && reelsQueue_().ids.length) return reelsGo_(chatId);
  // 兩種剪法：🎤 口播剪（有人講話）、🎵 靜音剪（沒講話：配樂卡點、轉場、運鏡、文字動畫）
  if (owner && chatId === owner && !reelsVideo && /^(口播剪|口播|剪口播)$/.test(rk) && reelsQueue_().ids.length) return reelsGo_(chatId, 'talk');
  if (owner && chatId === owner && !reelsVideo && /^(靜音剪|靜音|剪靜音)$/.test(rk) && reelsQueue_().ids.length) return reelsGo_(chatId, 'silent');
  if (owner && chatId === owner && !reelsVideo && /^(重選影片|重新選影片|清除影片)$/.test(rk)) {
    setProp_('REELS_Q', '');
    return tgSend_(chatId, { text: '🗑️ 收到的影片清掉了，重新傳影片給我就好。', buttons: [[REELS_BTN, REELS_LONG_BTN]] });
  }
  // 配樂：按了剪片按鈕後傳音樂檔，或音樂說明寫「配樂」，就用這首當配樂
  const music = msg.audio || (msg.document && /^audio\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (owner && chatId === owner && music && (reelsPending_() || /配樂/.test(text))) return reelsMusic_(chatId, music);
  // 剪好之後：回覆那支影片說要改哪裡，或打「改影片 …」「重剪 Reels」，就照要求再剪一版
  if (owner && chatId === owner && !reelsVideo && !fileId) {
    const rv = reelsRevise_(msg, text);
    if (rv) return reelsRun_(chatId, rv.fileId, rv.note, rv.ver, rv.ack, rv.mode, rv.kind);
  }
  // 照片也能剪 Reels（使用者 2026-10-17）：按了剪片按鈕後傳的照片，或照片說明寫「剪 Reels」，排進去一起剪；說明寫「風格」才是學字幕風格
  if (owner && chatId === owner && fileId && !/風格/.test(text) && (reelsPending_() || (REELS_WORD.test(text) && !msg.forward_origin && !msg.forward_date)))
    return reelsAdd_(chatId, { file_id: 'p:' + fileId, photo: true }, text);
  if (owner && chatId === owner && !fileId && /^(最後一張是風格截圖|學最後一張的風格)$/.test(rk)) {
    const q = reelsQueue_(), last = q.ids[q.ids.length - 1] || '';
    if (!/^p:/.test(last)) return tgSend_(chatId, '🎨 最後收到的不是照片，請把截圖重新傳一次，說明寫「風格」。');
    q.ids.pop(); setProp_('REELS_Q', JSON.stringify(q));
    return reelsStyle_(chatId, last.slice(2), null);
  }
  // 傳一張喜歡的影片截圖（說明有「風格」）：學下字幕的樣子，之後都照這個剪
  if (owner && chatId === owner && fileId && /風格/.test(text)) return reelsStyle_(chatId, fileId, doc);
  // 設定 GitHub 金鑰（剪 Reels 要用）：打完就把那則訊息刪掉
  const gk = text.match(/^設定\s*GitHub\s*金鑰\s*(\S+)$/i);
  if (owner && chatId === owner && gk) {
    setProp_('GITHUB_TOKEN', gk[1]);
    tgApi_('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    return tgSend_(chatId, '🔑 GitHub 金鑰存好了（剛剛那則訊息已經幫你刪掉）。現在可以按「' + REELS_BTN + '」試試看。');
  }

  // 案例庫：轉傳過來的圖片／影片／文字，或說明打「存」的，存起來之後可以用「查 關鍵字」找回來
  const forwarded = !!(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat);
  const video = msg.video || msg.animation || (msg.document && !doc ? msg.document : null);
  if (owner && chatId === owner && (video || forwarded || (fileId && casePending_()) || ((fileId || video) && /^(存|存案例|案例|收藏)/.test(text)))) {
    tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
    return tgSend_(chatId, saveTgCase_(msg, fileId, video, doc, text.replace(/^(存案例|存|案例|收藏)[\s：:]*/, '')));
  }

  if (voice) {
    if (!owner || chatId !== owner) return;
    tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
    let said;
    try {
      const info = JSON.parse(tgApi_('getFile', { file_id: voice.file_id }));
      const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/' + info.result.file_path).getBlob();
      said = transcribe_(blob, msg.voice ? 'voice.ogg' : (voice.file_name || 'audio.m4a'));
    } catch (err) { console.error(err); return tgSend_(chatId, '語音聽不清楚，再說一次或改打字看看。'); }
    if (!said) return tgSend_(chatId, '沒聽到內容，再說一次看看。');
    const ans = answer_(said);
    if (KIT_PENDING_) {
      tgSend_(chatId, '🎤 「' + said + '」\n\n' + ans);
      kitQueue_('tg', chatId);
      return;
    }
    const short = sendReportTg_(chatId);
    const carded = sendCardTg_(chatId);   // 智囊軍師：先傳圖卡
    tgSend_(chatId, short ? '🎤 「' + said + '」\n\n' + short : withVoice_(said, ans));
    if (!short && !carded && voiceMode_() !== 'off') speakTg_(chatId, ans);   // 用講的就用講的回
    return;
  }

  if (fileId) {
    if (!owner || chatId !== owner) return;
    tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
    let img;
    try { img = tgImage_(fileId, doc && doc.mime_type); }
    catch (err) { console.error(err); return tgSend_(chatId, '圖片讀取失敗，再傳一次看看。'); }
    IMG_NOT_ORDER_ = false;
    const ans = image_(text, img);
    // 在 Telegram 傳沒寫說明、又不是明細表的圖片：直接存進案例庫，之後找得到
    if (IMG_NOT_ORDER_ && !text) return tgSend_(chatId, saveTgCase_(msg, fileId, null, doc, ''));
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
    if (owner && owner !== chatId) return;   // 已經有主人：別人一律不回
    if (bind[1] !== prop_('SYNC_KEY')) return tgSend_(chatId, '同步密碼不對喔，再確認一次。');
    setProp_('TG_OWNER_CHAT_ID', chatId);
    return tgSend_(chatId, '綁定完成！之後直接跟我說話就好。傳「說明」可以看我會做什麼。');
  }
  if (!owner) return tgSend_(chatId, '請先傳「綁定 你的同步密碼」完成綁定。');
  if (chatId !== owner) return;   // 只回主人，其他人不回應

  tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
  const ans = answer_(text.replace(/^\/start\b\s*/, '') || '說明');
  if (KIT_PENDING_) {
    tgSend_(chatId, ans);
    kitQueue_('tg', chatId);
    return;
  }
  const short = sendReportTg_(chatId);
  const carded = sendCardTg_(chatId);
  tgSend_(chatId, short || ans);
  if (!short && !carded && voiceMode_() === 'always' && !/^語音回覆/.test(text)) speakTg_(chatId, ans);
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
  let rich = msg && typeof msg === 'object';
  // Telegram 沒辦法用按鈕打開相簿，「選照片／拍照」按鈕拿掉，改帶一般選單
  if (rich && msg.buttons && msg.buttons.length === 1 && msg.buttons[0] === PHOTO_BTNS) msg = { text: msg.text + '\n（按左下角的迴紋針 📎 選照片）' };
  else if (rich && msg.buttons && msg.buttons.indexOf(PHOTO_BTNS) >= 0) msg = { text: msg.text + '\n（按左下角的迴紋針 📎 選照片）', buttons: msg.buttons.filter(r => r !== PHOTO_BTNS) };
  if (msg && typeof msg === 'object' && msg.imgs && msg.imgs.length) {   // 款式預覽圖：先送一組相簿
    tgApi_('sendMediaGroup', { chat_id: chatId, media: msg.imgs.slice(0, 10).map((u, i) => ({ type: 'photo', media: u, caption: (msg.caps || [])[i] || '' })) });
  }
  rich = msg && typeof msg === 'object' && !!msg.buttons;
  if (msg && typeof msg === 'object' && !msg.buttons) msg = msg.text;
  tgApi_('sendMessage', { chat_id: chatId, text: String(rich ? msg.text : msg).slice(0, 4000),
    // 試算的問題用一次性的按鈕；其他回覆一律帶常用功能按鈕
    reply_markup: rich && msg.buttons && msg.buttons !== MENU
      ? { keyboard: quick_(msg.buttons).map(row => row.map(tgKey_)), one_time_keyboard: msg.buttons[0] !== MENU[0], resize_keyboard: true }
      : { keyboard: QUICK.map(row => row.map(tgKey_)), resize_keyboard: true, is_persistent: true } });
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
  const asked = parsed.acts.length;
  parsed.acts = allowedActs_(text, parsed.acts, history.filter(m => m.role === 'user').slice(-2).map(m => m.content));   // 使用者沒說要加／刪，就不動資料
  if (asked && !parsed.acts.length) parsed.clean = (parsed.clean || '') + '\n\n（這次沒有動到你的資料。要刪除請直接說「刪除○○」）';
  let done = [];
  if (parsed.acts.length) {
    done = withLock_(() => {
      const d = readAll_();
      const res = applyActions_(d, parsed.acts);
      if (res.length) writeAll_(d);
      return res;
    });
  }
  const answer = [parsed.clean || '好的！'].concat(done.length ? ['', '已幫你處理：'].concat(done) : []).join('\n');
  logChat_('assistant', answer);
  return answer;
}

// AI 偶爾會自己「幫忙」加行程（例如只是問今天行程，卻加了一筆開會）：
// 只有使用者的話聽起來是要新增，才接受新增；聽起來是要刪除或完成，才接受刪除／完成
const ADD_WORDS = /記|加入|加上|加一|新增|添加|安排|提醒|排入|排進|排一|預約|約了|約好|寫下|存起來|存下|建立|設定|叫我|通知我|別忘|不要忘|待辦|要做|鬧鐘/;
const WHEN_WORDS = /明天|後天|大後天|今天|今晚|晚上|早上|中午|下午|下週|下禮拜|下星期|星期|禮拜|週[一二三四五六日天]|\d+\s*[點:：]|\d+\s*[月號日]|[一二三四五六七八九十兩]+點/;
const ASK_WORDS = /什麼|甚麼|嗎|？|\?|幾點|有沒有|有哪些|哪些|查|看看|列出|是不是/;
const DEL_WORDS = /刪|取消|移除|拿掉|去掉|清掉|清除|清空|完成|做完|搞定|弄好了|不用了|不要了|結束了/;
// 使用者只回「是」「好」「確定」這類確認時，看前兩句自己說的話決定能不能加／刪
const CONFIRM_WORDS = /^(是|是的|對|對的|好|好的|嗯|確定|確認|沒錯|可以|要|對啊|好啊|ok|OK|Ok|yes|刪吧|刪掉吧|刪掉)[\s!！。.～~啊呀喔吧]*$/;
function allowedActs_(text, acts, prev) {
  let t = String(text || '');
  if (CONFIRM_WORDS.test(t.trim())) t += ' ' + (prev || []).join(' ');
  const addOk = ADD_WORDS.test(t) || (WHEN_WORDS.test(t) && !ASK_WORDS.test(t));
  const delOk = DEL_WORDS.test(t);
  return (acts || []).filter(a => a && ((a.type === 'delete' || a.type === 'done') ? delOk : addOk));
}

// 「今天行程」「我的待辦」「我的筆記」按鈕：直接照資料列出來，不經過 AI（不會亂加東西）
function listToday_() { return listDays_(0, 0, '今天'); }

// 問行程（今天／明天／後天／這週／下週／星期五／10月20日）：照日期整齊排好，不經過 AI
// a、b 是從今天算起的天數（含頭尾）
function listDays_(a, b, label) {
  const d = readAll_();
  const day = n => Utilities.formatDate(new Date(Date.now() + n * 864e5), TZ, 'yyyy-MM-dd');
  const from = day(a), to = day(b);
  const md = ds => Number(ds.slice(5, 7)) + '/' + Number(ds.slice(8, 10));
  const wk = ds => WEEK[new Date(ds + 'T12:00:00+08:00').getDay()];
  const inR = ds => ds >= from && ds <= to;
  // 已經過了時間的不顯示（今天稍早的行程、提醒）
  const nowAt = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm");
  const past = (ds, t) => !!t && ds + 'T' + t < nowAt;
  const evs = d.events.filter(e => inR(e.date) && !past(e.date, hm_(e.time))).sort(evCmp_);
  const rms = d.reminders.filter(r => !r.fired && inR(String(r.at).slice(0, 10)) && !past(String(r.at).slice(0, 10), hm_(String(r.at).slice(11, 16))))
    .sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const one = from === to;
  const head = one ? '⏰ ' + label + ' ' + md(from) + '（星期' + wk(from) + '）'
    : '🗓️ ' + label + '行程（' + md(from) + '～' + md(to) + '）';
  if (!evs.length && !rms.length) return head + '\n\n' + label + (from === day(0) && a === 0 ? '接下來' : '') + '沒有行程，也沒有提醒。';
  const evLine = e => '・' + (hm_(e.time) || '整天') + '　' + e.title + (e.place ? '＠' + e.place : '');
  const rmLine = r => '・' + String(r.at).slice(11, 16) + '　🔔 ' + r.text;
  let body = [];
  if (one) {
    body = (evs.length ? ['🗓️ 行程'].concat(evs.map(evLine)) : [])
      .concat(evs.length && rms.length ? [''] : [], rms.length ? ['🔔 提醒'].concat(rms.map(r => '・' + String(r.at).slice(11, 16) + '　' + r.text)) : []);
  } else {
    const days = {};
    evs.forEach(e => (days[e.date] = days[e.date] || []).push({ k: (hm_(e.time) || '00:00') + '0', t: evLine(e) }));
    rms.forEach(r => { const ds = String(r.at).slice(0, 10); (days[ds] = days[ds] || []).push({ k: String(r.at).slice(11, 16) + '1', t: rmLine(r) }); });
    Object.keys(days).sort().forEach((ds, i) => {
      if (i) body.push('');
      body.push('▍' + md(ds) + '（' + wk(ds) + '）');
      days[ds].sort((x, y) => x.k.localeCompare(y.k)).forEach(x => body.push(x.t));
    });
  }
  const dels = evs.map(evDelLabel_).concat(rms.map(r => '🗑️ 刪 ' + r.text)).slice(0, 8);
  return { buttons: [dels].concat(MENU), text: [head, ''].concat(body, ['', '要刪掉哪一筆，點下面的 🗑️ 按鈕就好。']).join('\n') };
}

// 「明天行程」「這週有什麼行程？」「星期五的安排」→ [起, 迄, 標題]；不是問行程就回 null
function dayAsk_(flat) {
  const t = flat.replace(/[，,。.！!？?]/g, '');
  if (/刪|取消|移除|記|加|新增|安排一|提醒我|排/.test(t.replace(/安排$/, ''))) return null;
  const near = t.match(/^(?:我)?(?:的)?(近期|最近|接下來|之後)(?:的|有)?(?:什麼|哪些)?(?:行程|安排)(?:嗎|呢)?$/);
  if (near) return [0, 13, '近期'];
  const m = t.match(/^(?:我)?(今天|今日|明天|明日|後天|大後天|這週|這禮拜|這星期|本週|下週|下禮拜|下星期|(?:這|下)?(?:週|星期|禮拜)[一二三四五六日天]|\d{1,2}[月\/]\d{1,2}[日號]?)(?:的|有)?(?:什麼|哪些)?(?:行程|安排|事情?)(?:嗎|呢)?$/);
  if (!m) return null;
  const w = m[1], now = new Date();
  const dow = Number(Utilities.formatDate(now, TZ, 'u')) % 7;   // 0＝星期日
  const simple = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 後天: 2, 大後天: 3 };
  if (w in simple) return [simple[w], simple[w], w.replace('今日', '今天').replace('明日', '明天')];
  const toSun = (7 - dow) % 7;   // 這週算到星期日
  if (/^(這週|這禮拜|這星期|本週)$/.test(w)) return [0, toSun, '這週'];
  if (/^(下週|下禮拜|下星期)$/.test(w)) return [toSun + 1, toSun + 7, '下週'];
  const wd = w.match(/^(這|下)?(?:週|星期|禮拜)([一二三四五六日天])$/);
  if (wd) {
    const target = '日一二三四五六'.indexOf(wd[2] === '天' ? '日' : wd[2]);
    let n = (target - dow + 7) % 7;
    if (wd[1] === '下') n = toSun + 1 + (target + 6) % 7;
    return [n, n, '星期' + (wd[2] === '天' ? '日' : wd[2])];
  }
  const dm = w.match(/^(\d{1,2})[月\/](\d{1,2})/);
  if (dm) {
    const y = Number(Utilities.formatDate(now, TZ, 'yyyy'));
    const today = new Date(Utilities.formatDate(now, TZ, 'yyyy-MM-dd') + 'T12:00:00+08:00');
    let dt = new Date(y + '-' + ('0' + dm[1]).slice(-2) + '-' + ('0' + dm[2]).slice(-2) + 'T12:00:00+08:00');
    if (isNaN(dt)) return null;
    if (dt < today - 864e5 * 1) dt = new Date(dt.getTime() + 365 * 864e5);
    const n = Math.round((dt - today) / 864e5);
    return [n, n, Number(dm[1]) + '/' + Number(dm[2])];
  }
  return null;
}
// 每一筆一個「🗑️ 刪 名稱」按鈕（最多 8 個），後面接常用功能
function delBtns_(labels) {
  const seen = {};
  const b = labels.filter(t => t && !seen[t] && (seen[t] = 1)).slice(0, 8).map(t => '🗑️ 刪 ' + t);
  return [b].concat(MENU);
}
// 「🗑️ 刪除行程」：今天起的行程依日期排好，每筆一個按鈕（帶日期、時間，同名的也分得出來），點一下就刪
function listDelEvents_(head) {
  const evs = futureEvents_();
  if (!evs.length) return { text: (head ? head + '\n\n' : '') + '🗑️ 目前沒有行程可以刪除。', buttons: (prop_('EV_UNDO') && head ? [['↩️ 復原']] : []).concat(MENU) };
  const list = evs.slice(0, 15).map(e => '・' + evMd_(e.date) + ' ' + (hm_(e.time) || '整天') + '　' + e.title);
  const btns = evs.slice(0, 10).map(evDelLabel_);
  return { buttons: [btns, (head && prop_('EV_UNDO') ? ['↩️ 復原'] : []).concat(['✅ 刪好了'])],
    text: (head ? [head, ''] : []).concat(['🗑️ 刪除行程', ''], list, evs.length > 15 ? ['…還有 ' + (evs.length - 15) + ' 筆'] : [],
    ['', '點下面要刪的那一筆就刪掉' + (evs.length > 10 ? '（列最近 10 筆）' : '') + '。']).join('\n') };
}
function listTodos_() {
  const list = readAll_().todos.filter(x => !x.done).slice(0, 30)
    .map(x => '・' + (x.pri === 'high' ? '❗' : '') + x.text + (x.due ? '（' + x.due.slice(5).replace('-', '/') + '）' : ''));
  return list.length ? ['✅ 我的待辦（' + list.length + '）', ''].concat(list).join('\n') : '✅ 目前沒有待辦。';
}
function listNotes_() {
  const names = readAll_().notes.slice(0, 15).map(noteName_);
  const list = names.map(t => '・' + t);
  return list.length ? { buttons: delBtns_(names), text: ['📝 最近筆記', ''].concat(list, ['', '要看哪一篇，跟我說「找 名稱」；要刪掉就按下面的 🗑️ 按鈕。']).join('\n') } : '📝 目前沒有筆記。';
}
function noteName_(n) { return n.title || String(n.body || '').replace(/\s+/g, ' ').slice(0, 20) || '（無標題）'; }

// 照名稱刪除：「刪除今天的開會」「刪掉楊子賢試算資料那筆筆記」「🗑️ 刪 開會」
// 只找到一筆就直接刪（寫進刪除紀錄，同步不會加回來）；好幾筆就列按鈕讓使用者選；找不到交給 AI
function delByName_(text) {
  const m = String(text || '').replace(/\s+/g, '').match(/^(?:幫我|請)?(?:刪除|刪掉|刪|移除|清除|拿掉)(.+)$/);
  if (!m) return null;
  let q = m[1].replace(/^(掉|一下|今天|明天|後天|的|那筆|這筆|那個|這個|一筆)+/, '')
    .replace(/(那筆|這筆|那個|這個|一筆|的)?(行程|筆記|待辦|提醒)?(吧|了|喔)?$/, '').replace(/(那筆|這筆|的)$/, '');
  if (!q) return null;
  const kind = /行程/.test(m[1]) ? 'events' : /筆記/.test(m[1]) ? 'notes' : /待辦/.test(m[1]) ? 'todos' : /提醒/.test(m[1]) ? 'reminders' : '';
  const names = { events: '行程', notes: '筆記', todos: '待辦', reminders: '提醒' };
  const label = (c, x) => c === 'notes' ? noteName_(x) : (x.title || x.text || '');
  const flat = t => String(t || '').replace(/\s+/g, '');
  const find = d => {
    const hits = [];
    Object.keys(names).filter(c => !kind || c === kind).forEach(c => (d[c] || []).forEach(x => {
      if (c === 'todos' && x.done) return;
      if (c === 'reminders' && x.fired) return;
      const L = flat(label(c, x));
      if (L && (L === q || (q.length >= 2 && L.indexOf(q) >= 0) || (L.length >= 2 && q.indexOf(L) >= 0))) hits.push({ c: c, x: x, L: L });
    }));
    const exact = hits.filter(h => h.L === q);   // 名稱完全一樣的優先（按 🗑️ 按鈕時）
    return exact.length ? exact : hits;
  };
  const hits0 = find(readAll_());
  if (!hits0.length) return null;
  const same = hits0.every(h => h.L === hits0[0].L);
  if (!same) return { text: '找到 ' + hits0.length + ' 筆，按你要刪的那一筆：', buttons: [hits0.slice(0, 8).map(h => '🗑️ 刪 ' + label(h.c, h.x))].concat(MENU) };
  const done = withLock_(() => {
    const d = readAll_(), hit = find(d)[0];
    if (!hit) return '';
    const now = Date.now(), id = hit.x.id;
    d[hit.c] = d[hit.c].filter(x => x.id !== id); d.deleted[id] = now;
    if (hit.c === 'events') d.reminders = d.reminders.filter(r => { if (r.src === id) { d.deleted[r.id] = now; return false; } return true; });
    writeAll_(d);
    return '🗑️ 已刪除' + names[hit.c] + '：' + label(hit.c, hit.x);
  });
  if (!done) return null;
  logChat_('user', text); logChat_('assistant', done);
  return done + (hits0.length > 1 ? '\n（還有 ' + (hits0.length - 1) + ' 筆同名的，要刪再按一次）' : '');
}

function reply_(replyToken, msg, extra, menu) {
  const rich = msg && typeof msg === 'object';
  const m = rich && msg.flex ? { type: 'flex', altText: msg.alt || '💎 小乖功能選單', contents: msg.flex }
    : { type: 'text', text: String(rich ? msg.text : msg).slice(0, 5000) };
  // menu：私訊主人時附常用功能按鈕（精簡成 5 個，其他在「💎 選單」卡片裡）
  const buttons = rich && msg.flex && !msg.alt ? QUICK : quick_(rich && msg.buttons ? msg.buttons : menu ? MENU : null);
  if (buttons) {
    m.quickReply = { items: [].concat.apply([], buttons).slice(0, 13)
      .map(lineQuick_) };
  }
  lineApi_('reply', { replyToken: replyToken, messages: (extra || []).concat([m]).slice(0, 5) });
}

// 推播的最後一則也帶快速回覆按鈕（2026-10-16 使用者：「回覆訊息後維持快速回覆」）
function withQuick_(msgs, buttons) {
  const last = msgs[msgs.length - 1];
  if (last && !last.quickReply) last.quickReply = { items: [].concat.apply([], quick_(buttons || MENU)).slice(0, 13).map(lineQuick_) };
  return msgs;
}
function push_(to, text) {
  lineApi_('push', { to: to, messages: withQuick_([{ type: 'text', text: String(text).slice(0, 5000) }]) });
}

function lineApi_(kind, payload) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + kind, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify(payload),
  });
  const code = res.getResponseCode();
  if (code !== 200) console.error('LINE ' + kind + ' 失敗：' + res.getContentText());
  return code;
}

/* ============ 提醒（時間驅動觸發條件，每 5 分鐘） ============ */
function checkReminders() {
  try { kitWatch_(); } catch (e) { console.error(e); }
  try { igRefresh_(); } catch (e) { console.error(e); }
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  if ((!owner && !tgOwner) || !prop_('SHEET_ID')) return;
  const due = withLock_(() => {
    const d = readAll_();
    const now = Date.now();
    const msgs = [];
    const purged = purgePast_(d);   // 順便把過了日期的行程刪掉
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
    if (msgs.length || purged) writeAll_(d);
    return { msgs: msgs, title: (d.profile && d.profile.title) || '小乖' };
  });
  if (!due.msgs.length) return;
  const note = due.title + '提醒你：\n' + due.msgs.join('\n');
  if (owner && prop_('LINE_CHANNEL_ACCESS_TOKEN')) push_(owner, note);
  if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) tgSend_(tgOwner, note);
}

// 過了日期的行程自動刪除（連同它的 30 分鐘前提醒），記進刪除紀錄，網頁同步時才不會加回來
function purgePast_(d) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), now = Date.now();
  const gone = d.events.filter(e => e.date && e.date < today).map(e => e.id);
  if (!gone.length) return 0;
  d.events = d.events.filter(e => gone.indexOf(e.id) < 0);
  d.reminders = d.reminders.filter(r => gone.indexOf(r.src) < 0);
  gone.forEach(id => { d.deleted[id] = now; });
  return gone.length;
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
const FIXED_MONTHLY = { '2711AB': 3, '777Q': 2, '168': 2, '111': 2, '101': 2, '火山甘露': 1 };   // 火山甘露：SOP 一個月一盒
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
    if (fallbackToChat) { IMG_NOT_ORDER_ = true; if (CURRENT_TG_CHAT_ && !String(text || '').trim()) return ''; return chat_(text, image); }
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
  if (fallbackToChat && !hasRows) { IMG_NOT_ORDER_ = true; if (CURRENT_TG_CHAT_ && !String(text || '').trim()) return ''; return chat_(text, image); }
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
  if (/依\s*PV|PV\s*補|不指定月|不選月|依目標/i.test(t)) o.months = 'none';   // 不選月數，照 PV／金額目標補
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
  // 月數優先：先問月數；選了月數就照月數算（不再問目標），選「依PV補」才問要補到多少
  // 說明欄或表上只寫了目標、沒寫月數，就當作依目標補
  const o = st.opts, hasTarget = o.target && o.target.kind !== 'none';
  if (!o.months && hasTarget) o.months = 'none';
  const needTarget = o.months === 'none' && !o.target;
  if (o.card === undefined || !o.months || needTarget || !joinAsked) {
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
    if (!st.opts.months) {
      return { text: intro.concat(['2️⃣ 要買滿幾個月？',
        '選了月數就照月數算；不選月數、想買到 22萬／30萬 PV 就選「依PV補」']).join('\n'),
        buttons: [['買滿1個月', '買滿2個月', '買滿3個月'], ['照明細表', '依PV補']] };
    }
    if (needTarget) {
      return { text: intro.concat(['3️⃣ 要補到多少 PV 或金額？',
        '可以選下面的按鈕，或直接打：「PV 15萬」「金額 30萬」；月數會自動拉長到達標為止']).join('\n'),
        buttons: [['22萬PV', '30萬PV'], ['照明細表']] };
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
  // 有選月數就只算那幾個月（月數優先，2026-10-15 使用者選的），不夠目標只註明還差多少；
  // 沒選月數才照目標把最後一個月份拉長到達標為止
  let base = months ? sliceMonths_(parsed, months) : parsed;
  // 要補到目標時，用「保養」欄（211、300、299A 這類基本款）往後補，不要把第三個月的 111／101／168 一起拉長
  const fill = target && !months;
  if (fill && (parsed.maintenance || []).length) {
    const amt = target.kind === 'amount';
    const r0 = applyCash211_(computeQuote_(prices, base));
    const got = r0.lines.reduce((a, l) => a + (amt ? l.price : l.pv), 0);
    if (r0.isSheet && got < target.value) {
      base = Object.assign({}, base, { maintenance: [],
        periods: (base.periods || []).concat([{ label: '保養', months: 1, rows: JSON.parse(JSON.stringify(parsed.maintenance)) }]) });
    }
  }
  let result = fitTarget_(prices, base, fill ? target.value : 0, target ? target.kind : '');
  // 明細表本身就超過目標才照 SOP 刪減；為了達標往後補的，不再回頭刪
  if (target && result.isSheet && !result.extended) result = trimToTarget_(prices, base, target, result);
  if (months) {
    let note = '🗓️ 買滿 ' + months + ' 個月';
    if (target) {
      const amt = target.kind === 'amount';
      const got = result.lines.reduce((a, l) => a + (amt ? l.price : l.pv), 0);
      const tName = amt ? '金額 NT$ ' + target.value.toLocaleString('en-US') : (target.value / 10000) + '萬PV';
      note += got >= target.value ? '，已達 ' + tName
        : '，離 ' + tName + ' 還差 ' + (amt ? 'NT$ ' : '') + (target.value - got).toLocaleString('en-US') + (amt ? '' : ' PV') + '（照月數算，沒有自動補）';
    }
    result.goalNote = note;
  }
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
  let extended = false;
  while (pvOf(r) < target && m < 36) {
    last.months = ++m;
    r = calc();
    extended = true;
  }
  r.extended = extended;
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

// 報表圖片上的組合價品名比較好懂：「2711AB(4)限2組」→「2711AB 4盒組合」、「2711AB(1)限8盒」→「2711AB 單盒」
function packName_(name) {
  return String(name).replace(/^(.+?)\((\d+)\)限\d+組$/, (m, a, b) => a + ' ' + b + '盒組合').replace(/^(.+?)\(1\)限\d+盒$/, '$1 單盒');
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
const REPORT_BY = '彥彬｜特助小乖';   // 報表上的「試算者」
const CARD_BY = '彥彬｜生活筆記 @248zwwwu';   // 智囊軍師圖卡底部署名
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
// 報表配色：象牙白香檳金（使用者 2026-10-16 選 A，版面照他給的截圖）
const RC = { bg: '#F6F1E7', paper: '#FBF8F2', row2: '#F3EDE1', line: '#E4DACA', ink: '#2A2118', soft: '#6E604E', gold: '#A07C34',
  gold2: '#C9A56A', headTx: '#F1DFB4', green: '#1F5C4E', track: '#E9E1D2', white: '#FFFDF8' };
function reportLayout_(r) {
  const d = reportData_(r);
  const n = x => Number(x).toLocaleString('en-US');
  // 原本報表的項目都保留（使用者 2026-10-16）：入會贈送／現金贈品標示、合計列、付款與天數、系統名、辨識提醒與時間
  const rows = r.lines.map(l => l.price || l.pv
    ? { name: packName_(l.name), qty: l.qty, price: n(Math.round(l.price / l.qty)), pv: n(Math.round(l.pv / l.qty)), amount: n(l.price), spv: n(l.pv) }
    : { name: l.name, qty: l.qty, price: '入會贈送', pv: '—', amount: '贈送', spv: '—', free: true });
  if (d.gifts) rows.push({ name: GIFT_NAME, qty: d.gifts, price: '滿 2 萬送 1', pv: '—', amount: '贈品', spv: '—', free: true });
  const boxes = r.lines.reduce((a, l) => a + l.qty, 0);

  const W = 540, X = 20, TW = 500, HEAD = 34, ROW = 29;
  const payTop = 96, whoTop = 136, tableTop = 184, TOTAL = 30;
  let y = tableTop + HEAD + rows.length * ROW + TOTAL + 12;
  const sumTop = y; y += 92 + 10;
  const tgtTop = y; y += 60 + 10;
  const bonusTop = y; const bonusH = d.bonusBlocked ? 44 : 28 + d.bonus.length * 19; y += bonusH + 8;
  const footTop = y; y += 26;

  const build = slide => {
    const req = [];
    req.push({ updatePageProperties: { objectId: slide, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb_(RC.bg) } } } }, fields: 'pageBackgroundFill.solidFill.color' } });
    let k = 0;
    const place = (w, h, x, yy) => ({ pageObjectId: slide,
      size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: h, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: yy, unit: 'PT' } });
    const shape = (type, x, yy, w, h, fill, outline) => {
      const id = (type === 'RECTANGLE' ? 'xg_rect_' : 'xg_box_') + (k++);
      req.push({ createShape: { objectId: id, shapeType: type, elementProperties: place(w, h, x, yy) } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'shapeBackgroundFill,outline', shapeProperties: {
        shapeBackgroundFill: fill ? { solidFill: { color: { rgbColor: rgb_(fill) } } } : { propertyState: 'NOT_RENDERED' },
        outline: outline ? { outlineFill: { solidFill: { color: { rgbColor: rgb_(outline) } } }, weight: { magnitude: 1, unit: 'PT' } }
          : { propertyState: 'NOT_RENDERED' } } } });
      return id;
    };
    const box = (x, yy, w, h, fill, outline) => shape('ROUND_RECTANGLE', x, yy, w, h, fill, outline);
    const rect = (x, yy, w, h, fill) => shape('RECTANGLE', x, yy, w, h, fill, null);
    const text = (str, x, yy, w, h, size, color, bold, align, font) => {
      const id = 'xg_txt_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: place(w, h, x, yy) } });
      req.push({ insertText: { objectId: id, text: String(str) } });
      req.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'fontSize,bold,foregroundColor,fontFamily', style: {
        fontSize: { magnitude: size, unit: 'PT' }, bold: !!bold, fontFamily: font || 'Noto Sans TC', foregroundColor: { opaqueColor: { rgbColor: rgb_(color) } } } } });
      req.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'alignment', style: { alignment: align || 'CENTER' } } });
      req.push({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: 'MIDDLE' }, fields: 'contentAlignment' } });
    };

    // 標題：YB 圓章＋康園試算報表，整組置中（標題約 180pt 寬，圓章放左邊，整組往右挪半個圓章）
    const seal = shape('ELLIPSE', 160, 26, 32, 32, null, RC.gold2);
    req.push({ insertText: { objectId: seal, text: 'YB' } });
    req.push({ updateTextStyle: { objectId: seal, textRange: { type: 'ALL' }, fields: 'fontSize,bold,foregroundColor,fontFamily', style: {
      fontSize: { magnitude: 12, unit: 'PT' }, bold: true, fontFamily: 'Cormorant Garamond', foregroundColor: { opaqueColor: { rgbColor: rgb_(RC.gold) } } } } });
    req.push({ updateParagraphStyle: { objectId: seal, textRange: { type: 'ALL' }, fields: 'alignment', style: { alignment: 'CENTER' } } });
    req.push({ updateShapeProperties: { objectId: seal, shapeProperties: { contentAlignment: 'MIDDLE' }, fields: 'contentAlignment' } });
    text('康園試算報表', X + 20, 18, TW, 48, 30, RC.ink, true, 'CENTER', 'Noto Serif TC');
    const date = r.date ? String(r.date) : Utilities.formatDate(new Date(), TZ, 'yyyy · MM · dd');
    text(date, X, 66, TW, 20, 14, RC.gold, false, 'CENTER', /^[\x00-\x7F·]*$/.test(date) ? 'Cormorant Garamond' : 'Noto Sans TC');
    rect(230, 90, 80, 1, RC.gold2);
    text('『彥彬🌿試算系統』', X, 4, TW, 14, 8, RC.soft, false, 'END');
    text((r.card ? '💳 刷卡' : '💵 現金') + (d.days ? '　｜　📦 預估可使用天數 ' + d.days + ' 天' : ''), X, payTop, TW, 32, 17, RC.gold, true);

    // 購買者／試算者
    const half = (TW - 10) / 2;
    [['購買者', r.name || '—'], ['試算者', REPORT_BY]].forEach((p, i) => {
      const x = X + i * (half + 10);
      box(x, whoTop, half, 36, RC.paper, RC.gold2);
      text(p[0], x + 8, whoTop, 60, 36, 14, RC.soft, true, 'START');
      text(p[1], x + 64, whoTop, half - 72, 36, 14, RC.ink, true, 'CENTER');
    });

    // 品項表：品項名稱｜數量｜單價｜PV｜小計金額｜小計 PV
    const COL = [{ x: 0, w: 156 }, { x: 156, w: 44 }, { x: 200, w: 66 }, { x: 266, w: 64 }, { x: 330, w: 88 }, { x: 418, w: 82 }];
    const cell = (ci, str, yy, h, size, color, bold, align) =>
      text(str, X + COL[ci].x + (ci === 0 ? 4 : 0), yy, COL[ci].w - (ci === 0 ? 4 : 0), h, size, color, bold, align || 'CENTER');
    let ty = tableTop;
    rect(X, ty, TW, HEAD, RC.ink);
    ['品項名稱', '數量', '單價', 'PV', '小計金額', '小計 PV'].forEach((h, ci) => cell(ci, h, ty, HEAD, 12, RC.headTx, true));
    ty += HEAD;
    rows.forEach((rw, i) => {
      rect(X, ty, TW, ROW, i % 2 ? RC.row2 : RC.paper);
      cell(0, rw.name, ty, ROW, rw.name.length > 12 ? 10 : 12, RC.ink, false, 'START');
      cell(1, rw.qty, ty, ROW, 14, RC.gold, true);
      cell(2, rw.price, ty, ROW, rw.free ? 10 : 12, rw.free ? RC.soft : RC.ink);
      cell(3, rw.pv, ty, ROW, 12, RC.ink);
      cell(4, rw.amount, ty, ROW, 12, rw.free ? RC.gold : RC.ink, rw.free);
      cell(5, rw.spv, ty, ROW, 12, RC.green, true);
      ty += ROW;
    });
    [1, 2, 3, 4, 5].forEach(ci => rect(X + COL[ci].x, tableTop + HEAD, 0.6, rows.length * ROW, RC.line));
    rect(X, ty, TW, TOTAL, RC.track);
    rect(X, ty, TW, 1, RC.gold2);
    cell(0, '合計', ty, TOTAL, 12, RC.ink, true, 'START');
    cell(1, boxes + ' 盒', ty, TOTAL, 11, RC.gold, true);
    cell(4, n(d.amount), ty, TOTAL, 12, RC.ink, true);
    cell(5, n(d.pv), ty, TOTAL, 12, RC.green, true);

    // 總金額／總 PV
    box(X, sumTop, half, 92, RC.ink, RC.gold2);
    text('總金額 NT$', X, sumTop + 8, half, 22, 13, RC.headTx, true);
    text(n(d.amount), X, sumTop + 30, half, 54, 38, RC.headTx, true, 'CENTER', 'Noto Serif TC');
    box(X + half + 10, sumTop, half, 92, RC.white, RC.gold2);
    text('總 PV', X + half + 10, sumTop + 8, half, 22, 13, RC.green, true);
    text(n(d.pv), X + half + 10, sumTop + 30, half, 54, 38, RC.green, true, 'CENTER', 'Noto Serif TC');

    // 22 萬／30 萬達標進度
    box(X, tgtTop, TW, 60, RC.paper, RC.gold2);
    TARGETS_PV.forEach((t, i) => {
      const x = X + 14 + i * (TW / 2), bw = TW / 2 - 28, color = i ? RC.green : RC.gold2;
      text(d.pv >= t ? '距離 ' + (t / 10000) + ' 萬 PV：0 🎉 已達標' : '距離 ' + (t / 10000) + ' 萬 PV：尚差 ' + n(t - d.pv),
        x, tgtTop + 8, bw, 24, 13, d.pv >= t ? RC.gold : RC.soft, true, 'START');
      box(x, tgtTop + 38, bw, 8, RC.track, null);
      const fw = Math.round(bw * Math.min(1, d.pv / t));
      if (fw > 4) box(x, tgtTop + 38, fw, 8, color, null);
    });

    // 預計獎金
    box(X, bonusTop, TW, bonusH, RC.paper, RC.line);
    if (d.bonusBlocked) {
      text('預計獎金：新入會需累積滿 20,000 PV 才開始計算，目前暫無', X + 12, bonusTop, TW - 24, bonusH, 12, RC.ink, true, 'START');
    } else {
      text('預計獎金（總金額 × 級距 %｜扣稅 10% 後）', X + 12, bonusTop + 4, TW - 24, 20, 12, RC.gold, true, 'START');
      d.bonus.forEach((b, i) => text(b.tier
        ? (b.type === '經理' ? '🏅 ' : '👤 ') + b.type + ' ' + b.pct + '%：約 NT$ ' + n(b.amount) + '　扣稅後 NT$ ' + n(b.afterTax)
        : b.type + '：PV 未達最低門檻', X + 12, bonusTop + 24 + i * 19, TW - 24, 19, 11, RC.ink, false, 'START'));
    }
    text(REPORT_BY + ' 自動試算｜數量依圖片辨識，請再核對　' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
      X, footTop, TW, 20, 9, RC.soft);
    return req;
  };
  return { W: W, H: y, build: build };
}

// 把試算畫成 PNG（失敗回 null，原因放在 REPORT_ERR_，不影響文字回覆）
let REPORT_ERR_ = '';
function reportPng_(r) {
  if (!r) return null;
  return layoutPng_(reportLayout_(r), '試算報表_' + (r.name || '') + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm') + '.png');
}

// 把一組版面（{ W, H, build }）用 Google 簡報畫成 PNG；試算報表和智囊軍師圖卡共用
function layoutPng_(L, fileName) {
  return layoutPngs_([L], [fileName])[0] || null;
}
// 好幾頁一起畫（頁面大小用第一頁的），每頁輸出一張 PNG；失敗回傳空陣列
function layoutPngs_(Ls, names) {
  return layoutDeck_(Ls, (pid, slides) => slides.map((id, i) => {
    const th = slidesApi_('get', '/' + pid + '/pages/' + id + '/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE');
    return UrlFetchApp.fetch(th.contentUrl).getBlob().setName(names[i]);
  })) || [];
}
// 整份簡報匯出成一個 PDF（7 頁 PDF 用）；失敗回傳 null
function layoutPdf_(Ls, name) {
  return layoutDeck_(Ls, pid => UrlFetchApp.fetch('https://docs.google.com/presentation/d/' + pid + '/export/pdf', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(name));
}
// 畫好簡報後交給 out(pid, slides) 輸出，最後把簡報丟到垃圾桶
function layoutDeck_(Ls, out) {
  const L = Ls[0];
  let pid = null;
  try {
    const deck = newDeck_(L.W, L.H);
    pid = deck.pid;
    const page = deck.pres.slides[0];
    const ps = deck.pres.pageSize, pt = v => v.unit === 'EMU' ? v.magnitude / 12700 : v.magnitude;
    const pw = pt(ps.width), ph = pt(ps.height);
    const slides = Ls.map((x, i) => i ? 'xg_pg_' + i : page.objectId);
    let req = (page.pageElements || []).map(e => ({ deleteObject: { objectId: e.objectId } }));
    Ls.forEach((x, i) => {
      if (i) req.push({ createSlide: { objectId: slides[i], insertionIndex: i, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
      let built = x.build(slides[i]);
      // 頁面沒改成直式時：整張等比縮小，置中放進預設的橫式頁面
      if (Math.abs(pw - x.W) > 1 || Math.abs(ph - x.H) > 1) {
        const sc = Math.min(pw / x.W, ph / x.H);
        built = scaleReq_(built, sc, (pw - x.W * sc) / 2, (ph - x.H * sc) / 2);
      }
      req = req.concat(built);
    });
    slidesApi_('post', '/' + pid + ':batchUpdate', { requests: req });
    return out(pid, slides);
  } catch (err) {
    REPORT_ERR_ = err.message;
    console.error('圖片失敗：' + err.message);
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
// opt：{ maxTokens, temperature }，長篇 JSON（名單包）用，避免被截斷
function callOpenAI_(system, messages, asJson, modelOverride, opt) {
  opt = opt || {};
  const model = modelOverride || prop_('MODEL') || 'gpt-4o-mini';
  const body = { model: model, messages: [{ role: 'system', content: system }].concat(messages) };
  if (asJson) body.response_format = { type: 'json_object' };
  if (/^gpt-5/.test(model)) body.max_completion_tokens = Math.max(4000, (opt.maxTokens || 0) + 4000);
  else {   // 辨識明細表要穩定、不能被截斷
    body.max_tokens = opt.maxTokens || (asJson ? 6000 : 2500);
    body.temperature = opt.temperature != null ? opt.temperature : (asJson ? 0 : 0.6);
  }
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
    .map(x => '- [' + x.id + '] ' + x.text + (x.due ? '（期限 ' + x.due + '）' : '') + (x.pri === 'high' ? '［重要］' : '')).join('\n') || '（無）';
  const evs = d.events.filter(e => e.date >= today).sort(evCmp_).slice(0, 30)
    .map(e => '- [' + e.id + '] ' + e.date + ' ' + (e.time || '整天') + ' ' + e.title + (e.place ? '＠' + e.place : '')).join('\n') || '（無）';
  const rms = d.reminders.filter(r => !r.fired).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, 30)
    .map(r => '- [' + r.id + '] ' + String(r.at).replace('T', ' ') + ' ' + r.text + (r.repeat && r.repeat !== 'none' ? '（' + (r.repeat === 'daily' ? '每天' : '每週') + '）' : '')).join('\n') || '（無）';
  const notes = d.notes.slice(0, 40)
    .map(n => '- [' + n.id + '] ' + (n.title || '（無標題）') + '：' + String(n.body || '').replace(/\s+/g, ' ').slice(0, 120)).join('\n') || '（無）';
  return '你是「' + (p.title || '小乖') + '」，' + (p.nick || '使用者') + '的私人助理。個性貼心、可靠、說話簡潔溫暖，一律用繁體中文（台灣用語）。\n'
    + '你現在在 LINE 或 Telegram 上聊天：回覆要短，不要用 Markdown 標題、表格或粗體。\n'
    + '列出行程、提醒或待辦時，一筆一行、照時間排好，格式像「・15:00　開會＠公司」；不同天先寫一行「▍10/16（四）」再列那天的。\n'
    + '你看得懂使用者傳來的圖片：收到圖片就直接讀出內容，不要說你看不到圖片。\n'
    + '現在時間：' + today + ' ' + hm + '（星期' + dow + '）。\n\n'
    + '【關於使用者】\n' + (p.about || '（尚未填寫）') + '\n\n'
    + '【目前未完成待辦】\n' + todos + '\n\n'
    + '【接下來的行程】\n' + evs + '\n\n'
    + '【尚未觸發的提醒】\n' + rms + '\n\n'
    + '【最近筆記】\n' + notes + '\n\n'
    + '【你可以直接幫使用者新增、刪除資料】\n'
    + '當使用者要你記下、安排、提醒、刪除或完成某件事時，先用一兩句話回覆確認，然後在回覆最後附上一個 ```actions 程式碼區塊，內容是 JSON 陣列，格式如下（只放需要的項目，日期時間一律換算成絕對值）：\n'
    + '```actions\n'
    + '[\n'
    + '  {"type":"todo","text":"繳電話費","due":"YYYY-MM-DD","pri":"normal 或 high"},\n'
    + '  {"type":"event","title":"牙醫回診","date":"YYYY-MM-DD","time":"HH:MM","place":"地點"},\n'
    + '  {"type":"reminder","text":"打電話給媽媽","at":"YYYY-MM-DDTHH:MM","repeat":"none 或 daily 或 weekly"},\n'
    + '  {"type":"note","title":"標題","body":"內容"},\n'
    + '  {"type":"delete","id":"上面清單方括號裡的 id"},\n'
    + '  {"type":"done","id":"待辦的 id（標記完成）"}\n'
    + ']\n'
    + '```\n'
    + '刪除或完成時，id 一定要照抄上面清單方括號裡的值，找不到對應的項目就問使用者是哪一筆，不要假裝已經刪掉。\n'
    + '使用者已經說要刪除、而且你知道是哪一筆時，直接附 actions 刪除，不用再問要不要確認；使用者回「是／好／確定」確認時，這一則就要附 actions 執行，不要只說「稍等，我會處理」。\n'
    + '沒有要新增或刪除東西時，不要附 actions 區塊。不要捏造使用者沒提過的行程。';
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
    } else if ((a.type === 'delete' || a.type === 'done') && a.id) {
      // 刪除要記進「刪除紀錄」，網頁同步時才不會把它又加回來
      const id = String(a.id).replace(/^\[|\]$/g, '').trim();
      const names = { todos: '待辦', events: '行程', reminders: '提醒', notes: '筆記' };
      Object.keys(names).some(c => {
        const i = (d[c] || []).findIndex(x => x.id === id);
        if (i < 0) return false;
        const x = d[c][i], label = x.text || x.title || '（無標題）';
        if (a.type === 'done' && c === 'todos') {
          x.done = true; x.doneAt = now; x.u = now;
          done.push('☑️ 完成待辦：' + label);
        } else {
          d[c].splice(i, 1); d.deleted[id] = now;
          done.push('🗑️ 刪除' + names[c] + '：' + label);
        }
        return true;
      });
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
    // 最新的在最上面（依建立時間，沒有就用更新時間）
    const rows = (d[c] || []).slice().sort((x, y) => (y.time || y.u || 0) - (x.time || x.u || 0))
      .map(x => [x.id, fmtTime_(x.u), summary_(c, x), JSON.stringify(x)]);
    replaceRows_(ss.getSheetByName(SHEETS[c]), rows, 4);
  });
  replaceRows_(ss.getSheetByName(SHEETS.deleted), Object.keys(d.deleted || {}).map(id => [id, d.deleted[id]]).sort((x, y) => y[1] - x[1]), 2);
  replaceRows_(ss.getSheetByName(SHEETS.profile), [[JSON.stringify(d.profile || {})]], 1);
  gcalSync_(d);
}

// 第一次用日曆同步：在編輯器選這個函式按「執行」，允許存取日曆；之後就會把今天以後的行程寫進日曆
function authorizeCalendar() {
  Logger.log('授權完成，行程會同步到「' + CalendarApp.getDefaultCalendar().getName() + '」。');
  writeAll_(readAll_());
}
/* ============ Google 日曆同步（2026-10-16 使用者選「同步日曆」：手機通知中心跳提醒） ============ */
// 每次存資料後比對：今天以後的行程寫進預設日曆（有時間的設 30 分鐘前跳通知），改了就重建，刪了就一起刪。
// 對照表存在指令碼屬性 GCAL_MAP：{ 行程id: [日曆id, 日期, 內容簽名] }；設定 GCAL=off 可關掉
function gcalSync_(d) {
  if (prop_('GCAL') === 'off' || typeof CalendarApp === 'undefined') return;
  try {
    let map = {};
    try { map = JSON.parse(prop_('GCAL_MAP') || '{}'); } catch (e) { map = {}; }
    const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    const sig = e => [e.date, hm_(e.time), e.title, e.place || ''].join('|');
    const live = {}; (d.events || []).forEach(e => { live[e.id] = e; });
    let cal = null, ops = 0, changed = false;
    const calendar = () => cal || (cal = CalendarApp.getDefaultCalendar());
    const drop = id => {
      try { const ce = CalendarApp.getEventById(map[id][0]); if (ce) ce.deleteEvent(); } catch (e) { console.error('日曆刪除失敗：' + e.message); }
      delete map[id]; changed = true; ops++;
    };
    Object.keys(map).forEach(id => {
      const e = live[id];
      if (!e) { if (map[id][1] < today) { delete map[id]; changed = true; } else if (ops < 30) drop(id); }   // 過了日期的留在日曆當紀錄
      else if (map[id][2] !== sig(e) && ops < 30) drop(id);   // 改過就刪掉重建
    });
    (d.events || []).forEach(e => {
      if (map[e.id] || !e.date || e.date < today || !e.title || ops >= 30) return;
      try {
        let ce;
        if (hm_(e.time)) {
          const st = new Date(parseAt_(e.date + 'T' + hm_(e.time)));
          ce = calendar().createEvent(e.title, st, new Date(st.getTime() + 36e5), e.place ? { location: e.place } : {});
          ce.removeAllReminders(); ce.addPopupReminder(30);
        } else {
          ce = calendar().createAllDayEvent(e.title, new Date(parseAt_(e.date + 'T00:00')));
          ce.removeAllReminders();
        }
        map[e.id] = [ce.getId(), e.date, sig(e)]; changed = true; ops++;
      } catch (err) { console.error('日曆新增失敗：' + err.message); }
    });
    if (changed) setProp_('GCAL_MAP', JSON.stringify(map));
  } catch (err) { console.error('日曆同步失敗：' + err.message); }
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
  newestFirst_(sh, 3);
  const rows = sh.getRange(2, 2, Math.min(n, last - 1), 2).getValues().reverse();   // 工作表新的在上面，給 AI 要照時間順序
  const msgs = rows.filter(r => r[0] === 'user' || r[0] === 'assistant').map(r => ({ role: r[0], content: String(r[1]) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function logChat_(role, content) {
  const sh = sheet_('chat');
  newestFirst_(sh, 3);
  prependRow_(sh, [new Date(), role, content]);
  if (sh.getLastRow() > 501) sh.deleteRows(502, sh.getLastRow() - 501);   // 最舊的在最下面，從下面刪
}

// 工作表一律「最新的在最上面」：新資料插在標題下第 2 列
function prependRow_(sh, row) {
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, row.length).setValues([row]).setFontWeight('normal');
}

// 舊的工作表是新的在下面，第一次用到時整張上下翻過來（之後就不用再翻）
function newestFirst_(sh, width) {
  const key = 'NEWEST_FIRST_' + sh.getName();
  if (prop_(key)) return;
  const last = sh.getLastRow();
  if (last > 2) {
    const a = sh.getRange(2, 1).getValue(), b = sh.getRange(last, 1).getValue();
    if (a instanceof Date && b instanceof Date && a.getTime() < b.getTime()) {
      const rng = sh.getRange(2, 1, last - 1, width);
      rng.setValues(rng.getValues().reverse());
    }
  }
  setProp_(key, '1');
}

/* ============ 小工具 ============ */
// 防呆（使用者 2026-10-17：智囊軍師重複動作加上防呆）：同一件事還在做，又按一次就不重做。
// ms 內做過標記就回 true（表示在忙）；沒有就標記起來回 false。做完用 busyEnd_ 清掉，當掉也會在 ms 後自動解除
function busy_(key, ms) {
  return withLock_(() => {
    if (Date.now() - (Number(prop_(key)) || 0) < ms) return true;
    setProp_(key, String(Date.now()));
    return false;
  });
}
function busyEnd_(key) { setProp_(key, ''); }
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
function hm_(t) { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''; }   // 「9:00」補成「09:00」才排得對
function evCmp_(a, b) { return (a.date + (hm_(a.time) || '00:00')).localeCompare(b.date + (hm_(b.time) || '00:00')); }
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

/* ============ 「小乖對話」頁面（像 Siri：按一下講話、可選照片，小乖用講的回） ============ */
const TALK_HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<style>
:root{--bg:#fff7f0;--card:#fff;--ink:#3b2a20;--soft:#8a7566;--accent:#ff8a3d;--me:#ffe3cf}
@media (prefers-color-scheme:dark){:root{--bg:#1d1714;--card:#2a221d;--ink:#f6ece4;--soft:#b8a597;--accent:#ff9d5c;--me:#4a3326}}
*{box-sizing:border-box}body{margin:0;font:17px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:var(--bg);color:var(--ink);height:100vh;display:flex;flex-direction:column}
header{padding:14px 16px 6px;display:flex;align-items:center;gap:10px}header b{font-size:20px}header small{color:var(--soft);margin-left:auto}
#log{flex:1;overflow:auto;padding:8px 16px 16px}
.m{max-width:85%;margin:8px 0;padding:10px 14px;border-radius:18px;white-space:pre-wrap;word-break:break-word}
.me{margin-left:auto;background:var(--me)}.xg{background:var(--card);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.m img{max-width:100%;border-radius:12px;display:block}
#bar{padding:10px 12px calc(12px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center;background:var(--card)}
#q{flex:1;min-width:0;border:1px solid #d9c8bb;border-radius:22px;padding:10px 14px;font:inherit;background:var(--bg);color:var(--ink)}
button{border:0;border-radius:50%;width:46px;height:46px;font-size:22px;background:var(--bg);color:var(--ink)}
#mic{width:64px;height:64px;font-size:30px;background:var(--accent);color:#fff}
#mic.on{animation:p 1s infinite}@keyframes p{50%{transform:scale(1.08);box-shadow:0 0 0 10px rgba(255,138,61,.25)}}
#hint{text-align:center;color:var(--soft);font-size:14px;padding:0 16px 6px}
#login{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:16px;z-index:9}
#login .box{background:var(--card);border-radius:18px;padding:20px;width:100%;max-width:360px}
#login p{color:var(--soft);font-size:15px;margin:8px 0 12px}#login .row{display:flex;gap:8px}
#pw{flex:1;min-width:0;border:1px solid #d9c8bb;border-radius:12px;padding:10px 12px;font:inherit;background:var(--bg);color:var(--ink)}
#pwgo{margin-top:14px;width:100%;height:46px;border-radius:12px;background:var(--accent);color:#fff;font-size:17px}
.sep{text-align:center;color:var(--soft);font-size:13px;margin:10px 0}
#chips{display:flex;gap:8px;overflow-x:auto;padding:4px 16px 10px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
#chips::-webkit-scrollbar{display:none}
.chip{flex:none;width:auto;height:auto;border-radius:18px;padding:7px 13px;font-size:15px;background:var(--card);border:1px solid #e6d3c4;white-space:nowrap}
.chip.ask{background:var(--accent);color:#fff;border-color:var(--accent)}
</style></head><body>
<header><b>🐾 小乖</b><button id="clr" class="chip" type="button" title="清除對話紀錄" style="margin-left:auto">🗑</button><small><label><input type="checkbox" id="spk" checked> 🔊 念出來</label> <label><input type="checkbox" id="loop" checked> 🔁 連續</label></small></header>
<div id="chips"></div>
<div id="log"><div class="m xg">嗨，我是小乖！按橘色麥克風跟我說話，或按 📷 選照片給我看。</div></div>
<div id="hint"></div>
<div id="bar"><button id="cam" title="照片">📷</button><input id="q" placeholder="打字或按鍵盤上的麥克風" enterkeyhint="send"><button id="mic" title="講話">🎤</button></div>
<input type="file" id="file" accept="image/*" hidden><audio id="au" playsinline></audio>
<div id="login"><div class="box"><b>🔒 小乖同步密碼</b><p id="lgmsg"></p>
<div class="row"><input id="pw" type="password" autocomplete="current-password" placeholder="同步密碼"><button id="pwshow" type="button">👁</button></div>
<button id="pwgo" type="button">開始使用</button></div></div>
<script>
let KEY=__KEY__;const $=id=>document.getElementById(id);
try{if(KEY)localStorage.setItem('xg_talk_key',KEY);else KEY=localStorage.getItem('xg_talk_key')||'';}catch(e){}
function login(msg){$('lgmsg').textContent=msg||'第一次使用，請輸入小乖的同步密碼（只要輸入一次，會記在這支手機上）';$('login').style.display='flex';$('pw').value='';}
$('pwgo').onclick=()=>{const k=$('pw').value.trim();if(!k)return;KEY=k;try{localStorage.setItem('xg_talk_key',KEY);}catch(e){}$('login').style.display='none';};
$('pwshow').onclick=()=>{$('pw').type=$('pw').type==='password'?'text':'password';};
if(!KEY)login();const log=$('log'),hint=$('hint');
let busy=false,rec=null,photo=null;
const MENU=['📋 試算','⏰ 今天行程','✅ 我的待辦','📝 我的筆記','📁 本機找','🌐 上網找','🗂️ 案例分類','❓ 說明'];
function chips(list){const c=$('chips');c.innerHTML='';const ask=list&&list.length;(ask?list:MENU).forEach(t=>{const b=document.createElement('button');b.className='chip'+(ask?' ask':'');b.textContent=t;
 b.onclick=()=>{if(t==='📋 試算'){$('q').value='試算';$('file').click();return;}send(t);};c.appendChild(b);});}
chips();
// 對話紀錄存在這支手機（關掉再開還在）：最多 200 則，照片存成小縮圖
const LOGK='xg_talk_log';
function saveLog(){try{const a=[...log.querySelectorAll('.m')].slice(1).map(d=>{const i=d.querySelector('img');return {c:d.className.replace(/^m /,''),t:d.textContent,i:i?(i.dataset.th||''):''};}).filter(x=>(x.t||x.i)&&!/^(小乖想一下|小乖在聽你說的話)…$/.test(x.t)).slice(-200);localStorage.setItem(LOGK,JSON.stringify(a));}catch(e){}}
function thumb(src,cb){const im=new Image();im.onload=()=>{const s=Math.min(1,240/Math.max(im.width,im.height));const c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);c.getContext('2d').drawImage(im,0,0,c.width,c.height);cb(c.toDataURL('image/jpeg',0.6));};im.src=src;}
function add(t,who,img){const d=document.createElement('div');d.className='m '+who;if(img){const i=new Image();i.src=img;if(/^data:/.test(img)&&img.length<20000)i.dataset.th=img;else thumb(img,th=>{i.dataset.th=th;saveLog();});d.appendChild(i);}if(t){d.appendChild(document.createTextNode(t));}log.appendChild(d);log.scrollTop=1e9;return d;}
try{const old=JSON.parse(localStorage.getItem(LOGK)||'[]');if(old.length){old.forEach(x=>add(x.t,x.c,x.i||null));const d=document.createElement('div');d.className='sep';d.textContent='— 以上是之前的對話 —';log.appendChild(d);log.scrollTop=1e9;}}catch(e){}
let clrT=0;$('clr').onclick=()=>{if(Date.now()-clrT>3000){clrT=Date.now();hint.textContent='再按一次 🗑 清除對話紀錄';return;}try{localStorage.removeItem(LOGK);}catch(e){}[...log.querySelectorAll('.m,.sep')].slice(1).forEach(d=>d.remove());hint.textContent='對話紀錄已清除';clrT=0;};
// iPhone 不讓網頁自己出聲：第一次按按鈕時先播一段無聲音檔「解鎖」，之後小乖的語音才放得出來
const SIL='data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NwwAAAAAAAAAAAAEluZm8AAAAPAAAABgAAAykAWlpaWlpaWlpaWlpaWlpaWnt7e3t7e3t7e3t7e3t7e3t7nJycnJycnJycnJycnJycnL29vb29vb29vb29vb29vb293t7e3t7e3t7e3t7e3t7e3t7/////////////////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQCowAAAAAAAAMpso+sIAAAAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=';
function unlock(){const a=$('au');if(!a.dataset.ok){a.src=SIL;const p=a.play();if(p)p.then(()=>{a.dataset.ok=1;}).catch(()=>{});}if(window.speechSynthesis&&!window._su){window._su=1;const u=new SpeechSynthesisUtterance(' ');u.volume=0;speechSynthesis.speak(u);}}
document.addEventListener('click',unlock,true);document.addEventListener('touchend',unlock,true);
// 連續對話：小乖講完自動再聽你說；說「結束／沒事了」或不說話就停（螢幕會保持亮著）
let conv=false,wl=null;
function convOn(){conv=true;try{if(navigator.wakeLock&&!wl)navigator.wakeLock.request('screen').then(l=>{wl=l;}).catch(()=>{});}catch(e){}}
function convOff(msg){conv=false;if(wl){wl.release().catch(()=>{});wl=null;}if(msg)hint.textContent=msg;}
function next(){if(conv&&$('loop').checked&&!busy&&!recOn)setTimeout(()=>{if(conv&&!busy&&!recOn)micStart();},350);}
function speak(t,audio){if(!$('spk').checked)return next();if(audio){const a=$('au');a.onended=next;a.src='data:audio/mpeg;base64,'+audio;const p=a.play();if(p)p.catch(()=>tts(t));return;}tts(t);}
function tts(t){if(!window.speechSynthesis)return next();speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.lang='zh-TW';u.rate=1.05;const v=speechSynthesis.getVoices().find(v=>/zh[-_]TW/i.test(v.lang));if(v)u.voice=v;u.onend=next;speechSynthesis.speak(u);}
function send(q,img,aud){if(busy)return;q=(q||'').trim();if(!q&&!img&&!aud)return;busy=true;const me=add(aud?'🎤 …':q,'me',img);$('q').value='';const w=add(aud?'小乖在聽你說的話…':'小乖想一下…','xg');hint.textContent='';
 google.script.run.withSuccessHandler(r=>{busy=false;if(/同步密碼不對/.test(r.say)){try{localStorage.removeItem('xg_talk_key');}catch(e){}login('同步密碼不對，請重新輸入');}if(aud)me.textContent='🎤 '+(r.heard||'（沒聽清楚）');w.textContent=r.show||r.say;saveLog();chips(r.buttons);if(/有事再叫我/.test(r.say))convOff('好，有事再按麥克風叫我');speak(r.say,r.audio);}).withFailureHandler(e=>{busy=false;w.textContent='連線有問題，再試一次：'+e.message;}).talk(KEY,q,img?img.split(',')[1]:'',$('spk').checked,aud?aud.b64:'',aud?aud.mime:'');}
$('q').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();send($('q').value);}});
// 講話：用手機錄音，送到小乖用 Whisper 轉文字（iPhone 的瀏覽器語音辨識常常沒反應，所以不用它）
let mr=null,chunks=[],stream=null,actx=null,recOn=false,stopT=null,heardAny=null;
function micUI(on){recOn=on;$('mic').classList.toggle('on',on);$('mic').textContent=on?'⏹':'🎤';}
// 全部關掉：錄音、麥克風、音量偵測（不管停在哪一步都關得掉）
function micCleanup(){clearTimeout(stopT);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}if(actx){actx.close().catch(()=>{});actx=null;}mr=null;micUI(false);}
function kb(msg){$('q').focus();hint.textContent=msg||'點鍵盤右下角的 🎤 講話，講完按「傳送」';}
async function micStart(){
 if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||!window.MediaRecorder)return kb();
 micUI(true);hint.textContent='開麥克風中…';
 try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
 catch(e){micCleanup();return kb('麥克風被擋住了：請到「設定 → Safari → 麥克風」選允許，或先按鍵盤上的 🎤 講話');}
 if(!recOn){micCleanup();hint.textContent='';return;}   // 開麥克風途中又按了一次＝取消
 const type=['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(t))||'';
 try{mr=type?new MediaRecorder(stream,{mimeType:type}):new MediaRecorder(stream);}catch(e){micCleanup();return kb();}
 heardAny=null;chunks=[];mr.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
 mr.onstop=()=>{const mt=(mr&&mr.mimeType)||type||'audio/mp4';micCleanup();hint.textContent='';const blob=new Blob(chunks,{type:mt});
  if(blob.size<1500||heardAny===false){convOff(conv?'對話先停在這裡，要講話再按麥克風':'沒錄到聲音，再按一次麥克風');return;}
  const fr=new FileReader();fr.onload=()=>send($('q').value,null,{b64:String(fr.result).split(',')[1],mime:mt.split(';')[0]});fr.readAsDataURL(blob);};
 mr.start(250);micUI(true);hint.textContent=conv&&$('loop').checked?'我在聽…（連續對話中，說「結束」或不說話就停）':'我在聽…講完停一下會自動送出，或再按一次麥克風';
 // 講完安靜 1.5 秒就自動送出；一直沒講話 8 秒就停
 try{actx=new (window.AudioContext||window.webkitAudioContext)();const an=actx.createAnalyser();an.fftSize=1024;actx.createMediaStreamSource(stream).connect(an);
  const d=new Uint8Array(an.fftSize),t0=Date.now();let heard=false,last=Date.now();heardAny=false;
  const tick=()=>{if(!mr)return;an.getByteTimeDomainData(d);let m=0;for(let i=0;i<d.length;i++)m=Math.max(m,Math.abs(d[i]-128));
   if(m>14){heard=true;heardAny=true;last=Date.now();}
   if((heard&&Date.now()-last>1500)||(!heard&&Date.now()-t0>8000)||Date.now()-t0>60000)return micStop();setTimeout(tick,100);};setTimeout(tick,300);}catch(e){}
}
function micStop(){if(mr&&mr.state!=='inactive'){try{mr.stop();}catch(e){micCleanup();return;}stopT=setTimeout(micCleanup,1500);}else micCleanup();}
$('mic').onclick=()=>{unlock();if(window.speechSynthesis)speechSynthesis.cancel();$('au').pause();if(recOn)return micStop();if(busy)return;convOn();micStart();};
$('cam').onclick=()=>$('file').click();
$('file').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const s=Math.min(1,1500/Math.max(im.width,im.height));const c=document.createElement('canvas');c.width=im.width*s;c.height=im.height*s;c.getContext('2d').drawImage(im,0,0,c.width,c.height);
 send($('q').value,c.toDataURL('image/jpeg',0.85));};im.src=r.result;};r.readAsDataURL(f);e.target.value='';};
</script></body></html>`;


/* ============ 🎬 剪 Reels：影片交給 GitHub Actions 剪（reels/reels.py），剪好直接傳回 Telegram ============ */
// 需要的指令碼屬性：GITHUB_TOKEN（可以在 Telegram 打「設定 GitHub金鑰 xxx」）；REELS_REPO 可不填，預設 yb131419/Tezhu
const REELS_WORD = /剪\s*reels|reels|剪\s*大片|剪片|剪輯|短影音/i;
function reelsPending_() { return Number(prop_('REELS_UNTIL')) > Date.now(); }
function reelsAsk_(t) {
  const k = String(t || '').replace(/\s+/g, '');
  if (/^(reels風格預設|reels預設風格|風格預設|恢復預設風格)$/i.test(k)) {
    setProp_('REELS_STYLE', '');
    return '🎨 Reels 風格換回預設了：白色粗體字幕、下方偏中間、黃色標籤。';
  }
  if (/^(不要我的配樂|配樂預設|用小乖的配樂)$/.test(k)) {
    setProp_('REELS_MUSIC', '');
    return '🎵 好，之後用小乖挑的配樂（依影片氣氛自動選）。';
  }
  const long = /^(剪大片|大片|大片剪輯|剪輯大片)$/.test(k);
  if (!long && !/^(剪reels|reels|剪短影音|短影音剪輯|剪輯reels)$/i.test(k)) return null;
  if (!LINE_MODE_ && CURRENT_TG_CHAT_) setProp_('REELS_Q', '');   // 重新按按鈕就重新收影片
  if (LINE_MODE_ || !CURRENT_TG_CHAT_) return '🎬 剪片目前要在 Telegram 用：在 Telegram 按「' + (long ? REELS_LONG_BTN : REELS_BTN) + '」再傳影片，剪好會傳回 Telegram。';
  setProp_('REELS_UNTIL', String(Date.now() + 10 * 60 * 1000));
  setProp_('REELS_MODE', long ? 'long' : 'reels');
  const mine = prop_('REELS_MUSIC') ? '・配樂：用你傳的那首（打「配樂預設」換回小乖挑的）\n' : '・想用自己的配樂：先傳一首音樂檔給我\n';
  if (long) return '🎞️ 好！剪大片：10 分鐘內把影片傳給我（按左下角的迴紋針 📎 選影片，每支 20MB 以內，可以傳好幾支），傳完選「' + REELS_TALK_BTN + '」或「' + REELS_SILENT_BTN + '」。\n\n'
    + '大片會保留整支影片的內容和原本的橫直，只剪掉停頓和口誤，上中文字幕、開頭動畫字卡、配樂。\n\n'
    + '影片說明可以寫要求，例如：\n・中英字幕\n・標題：準提佛祖開運加持\n・不要配樂，或配樂要溫暖鋼琴／禪意\n' + mine
    + '\n剪好後長按影片按「回覆」說要改哪裡，就會再剪一版。';
  return '🎬 好！10 分鐘內把影片或照片傳給我（按左下角的迴紋針 📎，可以一次選好幾個，最多 ' + REELS_MAX + ' 個；只傳照片也可以，會做成照片 Reels），傳完選一種剪法：\n' + REELS_KIND_TIP + '\n\n'
    + '影片說明可以順便寫要求，例如：\n・30秒\n・標題：我想要做短影音\n・只要中文字幕／不要字幕\n・不要特效／不要進度條\n・不要配樂，或配樂要輕快／溫暖鋼琴／大氣／禪意\n' + mine + '\n'
    + '沒寫就照預設：直式 9:16、口播最長 60 秒、靜音約 20 秒、依氣氛挑配樂、上方進度條。\n'
    + '想學某支影片的字幕風格：傳截圖時說明寫「風格」。\n'
    + '剪好後長按影片按「回覆」說要改哪裡，就會再剪一版。';
}
function reelsMusic_(chatId, music) {
  if (music.file_size && music.file_size > 20 * 1024 * 1024) return tgSend_(chatId, '🎵 這首音樂超過 20MB，Telegram 不讓機器人下載，換一首小一點的。');
  setProp_('REELS_MUSIC', music.file_id);
  setProp_('REELS_UNTIL', String(Date.now() + 10 * 60 * 1000));
  return tgSend_(chatId, '🎵 配樂記住了' + (music.title || music.file_name ? '：' + (music.title || music.file_name) : '')
    + '\n之後剪的影片都用這首（有人說話時會自動變小聲）。現在可以傳影片了；打「配樂預設」換回小乖挑的。'
    + '\n請用你有權使用的音樂，發到社群才不會被檢舉。');
}
function reelsLast_() { try { return JSON.parse(prop_('REELS_LAST') || 'null'); } catch (e) { return null; } }
// 收到的影片先排隊（可以一次傳好幾支，最多 10 支），傳完按「✂️ 開始剪」照傳的順序接起來剪成一支
const REELS_MAX = 10;
const REELS_GO_BTN = '✂️ 開始剪';
const REELS_TALK_BTN = '🎤 口播剪', REELS_SILENT_BTN = '🎵 靜音剪';
const REELS_KIND_TIP = '・' + REELS_TALK_BTN + '：影片裡有人講話。上字幕、剪掉停頓和口誤、推近鏡頭、重點字卡跳出來。\n'
  + '・' + REELS_SILENT_BTN + '：沒有講話的畫面（產品、活動、風景、照片）。跟著配樂節奏切、轉場特效、運鏡、文字動畫。\n'
  + '・' + REELS_GO_BTN + '：小乖自己判斷有沒有人講話。';
function reelsQueue_() {
  try { const q = JSON.parse(prop_('REELS_Q') || 'null'); if (q && q.ids && Date.now() - (q.at || 0) < 60 * 60 * 1000) return q; } catch (e) { /* 壞掉就重來 */ }
  return { ids: [], note: '', sec: 0, mode: '', kind: '', at: 0 };
}
// 收到幾支影片、幾張照片（照片的編號前面有「p:」）
function reelsCount_(ids) {
  const p = ids.filter(x => /^p:/.test(x)).length, v = ids.length - p;
  return [v ? v + ' 支影片' : '', p ? p + ' 張照片' : ''].filter(Boolean).join('、');
}
const REELS_STYLE_BTN = '🎨 最後一張是風格截圖';
function reelsAdd_(chatId, video, note) {
  if (!video.photo && video.file_size && video.file_size > 20 * 1024 * 1024) {
    return tgSend_(chatId, '🎬 這支影片超過 20MB，Telegram 不讓機器人下載。請傳影片時選「壓縮」（不要用檔案傳），或先剪短一點再傳。其他影片照樣收著。');
  }
  const q = reelsQueue_();
  if (q.ids.length >= REELS_MAX) return tgSend_(chatId, { text: '🎬 已經收到 ' + REELS_MAX + ' 個了（影片和照片加起來最多 ' + REELS_MAX + ' 個），選一種剪法開始剪。', buttons: [[REELS_TALK_BTN, REELS_SILENT_BTN], [REELS_GO_BTN]] });
  note = String(note || '').trim();
  if (!q.mode) q.mode = /大片/.test(note) ? 'long' : /reels/i.test(note) ? 'reels' : (prop_('REELS_MODE') || 'reels');
  else if (/大片/.test(note)) q.mode = 'long';
  if (/靜音/.test(note)) q.kind = 'silent';
  else if (/口播/.test(note)) q.kind = 'talk';
  q.ids.push(video.file_id);
  q.sec += Number(video.duration) || 0;
  const extra = note.replace(REELS_WORD, '').replace(/大片/g, '').trim();
  if (extra) q.note = (q.note ? q.note + '\n' : '') + extra;
  q.at = Date.now();
  setProp_('REELS_Q', JSON.stringify(q));
  setProp_('REELS_UNTIL', String(Date.now() + 10 * 60 * 1000));   // 繼續傳下一支
  const kind = q.mode === 'long' ? '🎞️ 剪大片' : '🎬 剪 Reels';
  const onlyPhotos = q.ids.every(x => /^p:/.test(x));
  if (video.photo) return tgSend_(chatId, { text: kind + '：收到第 ' + q.ids.length + ' 個（目前 ' + reelsCount_(q.ids) + '）。\n'
    + '還有要一起剪的照片或影片就繼續傳（照傳的順序接起來，最多 ' + REELS_MAX + ' 個）。'
    + (onlyPhotos ? '\n全部是照片會用' + REELS_SILENT_BTN + '：每張照片運鏡、轉場、跟著配樂、文字動畫，每張約 2.5 秒（說明寫「每張 3 秒」可以改）。傳完按「' + REELS_GO_BTN + '」。'
      : '\n傳完選一種剪法：\n' + REELS_KIND_TIP)
    + '\n\n這張其實是想學字幕風格的截圖？按「' + REELS_STYLE_BTN + '」。',
    buttons: onlyPhotos ? [[REELS_GO_BTN], [REELS_STYLE_BTN, '🗑️ 重選影片']] : [[REELS_TALK_BTN, REELS_SILENT_BTN], [REELS_GO_BTN, '🗑️ 重選影片'], [REELS_STYLE_BTN]] });
  return tgSend_(chatId, { text: kind + '：收到第 ' + q.ids.length + ' 個' + (video.duration ? '（這支 ' + video.duration + ' 秒）' : '') + '，目前 ' + reelsCount_(q.ids) + '。\n'
    + '還有要一起剪的影片或照片就繼續傳（照傳的順序接起來），傳完選一種剪法：\n' + REELS_KIND_TIP,
    buttons: [[REELS_TALK_BTN, REELS_SILENT_BTN], [REELS_GO_BTN, '🗑️ 重選影片']] });
}
function reelsGo_(chatId, kind) {
  const q = reelsQueue_();
  kind = kind === 'talk' || kind === 'silent' ? kind : (q.kind || 'auto');
  const onlyPhotos = q.ids.length && q.ids.every(x => /^p:/.test(x));
  if (onlyPhotos) kind = 'silent';   // 照片沒有人講話
  setProp_('REELS_Q', '');
  setProp_('REELS_UNTIL', '0');
  const n = q.ids.length, sec = q.sec ? '（影片共 ' + q.sec + ' 秒）' : '';
  const what = onlyPhotos ? n + ' 張照片' : n > 1 ? reelsCount_(q.ids) + sec + '接起來' : '影片' + sec;
  const how = onlyPhotos ? '每張照片運鏡、轉場、跟著配樂、文字動畫' : kind === 'silent' ? '靜音剪：跟著配樂節奏切、轉場特效、運鏡、文字動畫'
    : kind === 'talk' ? '口播剪：剪掉停頓和口誤、上字幕、推近鏡頭、動畫字卡' : '自動判斷有沒有人講話，再選口播剪或靜音剪';
  return reelsRun_(chatId, q.ids.join(','), q.note, 1,
    q.mode === 'long'
      ? '🎞️ 開始剪大片第 1 版：' + what + '，保留完整內容，' + how + '、配樂。影片越長要越久，剪好直接傳給你。'
      : '🎬 開始試剪第 1 版：' + what + '，' + how + '、配樂。大約 3～6 分鐘剪好直接傳給你。', q.mode, kind);
}
// 修改：回覆小乖傳的成品影片，或「改影片 …」「改 Reels …」；「重剪 Reels」用目前的風格重剪
function reelsRevise_(msg, text) {
  const last = reelsLast_();
  if (!last || !text) return null;
  const rt = msg.reply_to_message, k = text.replace(/\s+/g, '');
  let ask = '';
  if (rt && rt.from && rt.from.is_bot && /^🎬 第 \d+ 版/.test(rt.caption || '')) ask = text;
  else if (/^(改|修改)(影片|reels|短影音)/i.test(k)) ask = text.replace(/^\s*(改|修改)\s*(影片|reels|短影音)[\s：:]*/i, '');
  else if (/^(重剪|重新剪)(reels|影片|一次|一版)?$/i.test(k) || /^用這個風格重剪$/.test(k.replace(/^[^\p{L}\p{N}]+/u, ''))) ask = '照目前的風格重剪';
  if (!ask) return null;
  const ver = (Number(last.ver) || 1) + 1;
  return { fileId: last.fileId, ver: ver, mode: last.mode || 'reels', kind: last.kind || 'auto', note: (last.note ? last.note + '\n' : '') + '第 ' + ver + ' 版修改：' + ask,
    ack: '✂️ 收到，照你說的「' + ask.slice(0, 40) + '」剪第 ' + ver + ' 版，好了直接傳給你。' };
}
function reelsRun_(chatId, fileId, note, ver, ack, mode, kind) {
  mode = mode === 'long' ? 'long' : 'reels';
  kind = kind === 'talk' || kind === 'silent' ? kind : 'auto';
  if (!prop_('GITHUB_TOKEN')) return tgSend_(chatId, '🎬 剪 Reels 還沒設定好：請先傳「設定 GitHub金鑰 你的金鑰」給我（設定步驟在 README 的「剪 Reels」）。');
  note = String(note || '').slice(-600);   // 修改要求越疊越多時只留最後的部分
  const repo = prop_('REELS_REPO') || 'yb131419/Tezhu';
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/actions/workflows/reels.yml/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: 'main', inputs: {
      chat_id: String(chatId), file_id: fileId, note: note, style: prop_('REELS_STYLE') || '', version: String(ver),
      mode: mode, music: prop_('REELS_MUSIC') || '', kind: kind,
    } }),
  });
  const code = res.getResponseCode();
  if (code !== 204) {
    console.error('剪 Reels 觸發失敗：' + code + ' ' + res.getContentText());
    return tgSend_(chatId, code === 401 || code === 403 || code === 404
      ? '🎬 GitHub 金鑰不對或權限不夠（' + code + '），請重新產生金鑰後傳「設定 GitHub金鑰 新金鑰」。'
      : '🎬 現在沒辦法開始剪（' + code + '），請等一下再傳一次。');
  }
  setProp_('REELS_LAST', JSON.stringify({ fileId: fileId, note: note, ver: ver, mode: mode, kind: kind, at: Date.now() }));
  return tgSend_(chatId, ack);
}
// 看截圖學字幕風格：顏色、大小、位置、有沒有底色框、標籤顏色
const REELS_STYLE_PROMPT = [
  '你是短影音剪輯師。看這張短影音截圖，整理它的字幕和字卡風格，只回 JSON：',
  '{"sub_color":"#RRGGBB 字幕字的顏色","sub_outline":"#RRGGBB 字幕描邊或底色框的顏色",',
  '"sub_box":true/false 字幕有沒有底色框,"sub_size":0.6~1.6 字幕大小（一般短影音的大小算 1）,',
  '"sub_pos":"bottom/lower/middle/upper 字幕位置（lower＝下方偏中間）","accent":"#RRGGBB 標籤或重點字卡的強調色，看不出來就用 #F5C842",',
  '"subs":"both/zh/en 有中英兩行就 both，只有中文 zh","desc":"用一句繁體中文描述這個風格"}',
].join('\n');
function reelsStyle_(chatId, fileId, doc) {
  setProp_('REELS_UNTIL', String(Date.now() + 10 * 60 * 1000));   // 學完風格還可以接著傳影片
  tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
  let st;
  try {
    const img = tgImage_(fileId, doc && doc.mime_type);
    st = JSON.parse(callOpenAI_(REELS_STYLE_PROMPT, [{ role: 'user', content: [
      { type: 'text', text: '這是我喜歡的短影音風格截圖。' }, { type: 'image_url', image_url: { url: img } }] }], true));
  } catch (err) { console.error(err); return tgSend_(chatId, '🎨 截圖看不清楚，換一張字幕比較明顯的再傳一次。'); }
  const desc = String(st.desc || '').slice(0, 80);
  delete st.desc;
  setProp_('REELS_STYLE', JSON.stringify(st));
  const btns = reelsLast_() ? [['🔁 用這個風格重剪'], ['🎬 剪 Reels']] : [['🎬 剪 Reels']];
  return tgSend_(chatId, { text: '🎨 記住這個風格了' + (desc ? '：' + desc : '') + '\n之後剪的 Reels 都照這個樣子。'
    + '\n現在傳影片就會用這個風格剪；打「Reels 風格預設」可以換回原本的。', buttons: btns });
}


/* ============ 📤 發社群：用 Meta 官方 API 直接發到 IG、Threads、Facebook 粉專（圖卡、Reels、照片影片），不用第三方 ============ */
// 指令碼屬性（傳「設定 IG金鑰／Threads金鑰／FB金鑰 權杖」會自動填，有設定的平台才會出現）：
//   IG：IG_TOKEN、IG_USER、IG_NAME、IG_API（ig＝Instagram 登入的權杖 graph.instagram.com；fb＝粉專權杖 graph.facebook.com）
//   Threads：TH_TOKEN、TH_USER、TH_NAME（graph.threads.net）
//   FB 粉專：FB_TOKEN（粉專權杖）、FB_PAGE、FB_NAME
// 流程：做好圖卡 → 按「📤 發社群」→ 看預覽，按「✅ 全部發」或「只發 IG」… → 另一次執行（觸發條件）上傳、等平台處理、發出，發好傳連結回來
const IG_BTN = '📤 發社群';
const IG_NO = '❌ 不發';
const IG_VER = 'v23.0';
const IG_FOLDER = '小乖IG發文';   // 發文時的暫存檔（IG、Threads 要從網址抓），發完就丟垃圾桶
const IG_WORD = /^(?:發|發到|發佈|發布|發文到|po|PO|貼到|分享到)\s*(?:IG|ig|Ig|instagram|Instagram|哀居|threads|Threads|脆|FB|fb|Fb|facebook|Facebook|臉書|粉專|社群|全部)(?![a-zA-Z])/;
const SOC = {
  ig: { name: 'IG', ok: () => !!(prop_('IG_TOKEN') && prop_('IG_USER')), who: () => '@' + prop_('IG_NAME') },
  th: { name: 'Threads', ok: () => !!(prop_('TH_TOKEN') && prop_('TH_USER')), who: () => '@' + prop_('TH_NAME') },
  fb: { name: 'FB', ok: () => !!(prop_('FB_TOKEN') && prop_('FB_PAGE')), who: () => '粉專「' + prop_('FB_NAME') + '」' },
  tk: { name: 'TikTok', ok: () => !!prop_('TK_REFRESH'), who: () => '草稿匣', video: true },   // TikTok 只收影片，送到草稿匣，你在 App 加音樂再發
};
const TH_MAX = 500;   // Threads 一則最多 500 字

function socOn_() { return Object.keys(SOC).filter(k => SOC[k].ok()); }
// 這則可以發到哪些平台：TikTok 只收影片
function socFor_(post) {
  const vid = !!(post && post.items && post.items.some(x => x.t === 'video'));
  return socOn_().filter(k => !SOC[k].video || vid);
}
function igReady_() { return socOn_().length > 0; }
function socNames_(ks) { return ks.map(k => SOC[k].name).join('＋'); }

// 呼叫 Meta 的 API（三個平台格式一樣）；payload 可以放檔案（上傳照片、影片）
function metaCall_(host, method, path, params, token) {
  const p = Object.assign({}, params || {}, { access_token: token });
  const res = method === 'get'
    ? UrlFetchApp.fetch(host + path + '?' + Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&'), { muteHttpExceptions: true })
    : UrlFetchApp.fetch(host + path, { method: 'post', payload: p, muteHttpExceptions: true });
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { j = {}; }
  if (res.getResponseCode() !== 200 || j.error) throw new Error(igErr_(j.error || { message: 'HTTP ' + res.getResponseCode() }));
  return j;
}
function igHost_() { return prop_('IG_API') === 'fb' ? 'https://graph.facebook.com/' + IG_VER + '/' : 'https://graph.instagram.com/' + IG_VER + '/'; }
function igCall_(method, path, params) { return metaCall_(igHost_(), method, path, params, prop_('IG_TOKEN')); }
function thCall_(method, path, params) { return metaCall_('https://graph.threads.net/v1.0/', method, path, params, prop_('TH_TOKEN')); }
function fbCall_(method, path, params, video) { return metaCall_('https://graph' + (video ? '-video' : '') + '.facebook.com/' + IG_VER + '/', method, path, params, prop_('FB_TOKEN')); }
// Meta 的錯誤翻成看得懂的話
function igErr_(e) {
  const m = String(e.error_user_msg || e.message || ''), code = Number(e.code), sub = Number(e.error_subcode);
  if (code === 190 || /access token|session has expired/i.test(m)) return '金鑰失效或過期了，請重新產生權杖後再設定一次。';
  if (code === 10 || code === 200 || /permission/i.test(m)) return '權限不夠（要有發文權限），請重新產生權杖並把權限都打勾。';
  if (sub === 2207009 || /aspect ratio/i.test(m)) return '圖片比例不符合（要在 4:5 直式到 1.91:1 橫式之間）。';
  if (code === 9004 || sub === 2207052 || /download/i.test(m)) return '平台抓不到圖片／影片檔案。';
  if (code === 4 || code === 9 || code === 368 || sub === 2207042 || /limit/i.test(m)) return '發文次數到上限了，晚一點再發。';
  return m.slice(0, 160) || '原因不明';
}

/* ---- 設定權杖 ---- */
function igSetToken_(tok) {
  tok = String(tok || '').trim();
  const get = (host, path) => {
    const res = UrlFetchApp.fetch(host + path + (path.indexOf('?') < 0 ? '?' : '&') + 'access_token=' + encodeURIComponent(tok), { muteHttpExceptions: true });
    let j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) { j = {}; }
    if (j.error) throw new Error(igErr_(j.error));
    return j;
  };
  try {
    if (!/^EAA/.test(tok)) {   // Instagram 登入的權杖（IGAA… 開頭）
      const me = get('https://graph.instagram.com/' + IG_VER + '/', 'me?fields=user_id,username,account_type');
      if (me.account_type && !/BUSINESS|CREATOR/.test(me.account_type)) return '📸 @' + me.username + ' 還是個人帳號，請先在 IG 切換成「專業帳號」（商業或創作者），再重新產生權杖。';
      ['IG_TOKEN', 'IG_USER', 'IG_NAME', 'IG_API', 'IG_TOKEN_AT'].forEach((k, i) => setProp_(k, [tok, String(me.user_id || me.id), me.username || '', 'ig', String(Date.now())][i]));
      return socSetDone_('IG @' + prop_('IG_NAME'));
    }
    const pages = (get('https://graph.facebook.com/' + IG_VER + '/', 'me/accounts?fields=' + encodeURIComponent('name,access_token,instagram_business_account{id,username}') + '&limit=50').data || [])
      .filter(p => p.instagram_business_account);
    if (!pages.length) return '📸 這個權杖找不到有綁 IG 的粉專。請確認 IG 已切換成專業帳號、並在粉專設定裡連結 IG，產生權杖時也要勾選那個粉專。';
    setProp_('IG_PAGES', JSON.stringify(pages.map(p => ({ t: p.access_token, id: p.instagram_business_account.id, u: p.instagram_business_account.username }))));
    if (pages.length === 1) return igPickPage_(pages[0].instagram_business_account.username);
    return { text: '📸 這個權杖有好幾個 IG 帳號，要發到哪一個？', buttons: chunk_(pages.map(p => '📸 IG：@' + p.instagram_business_account.username), 1) };
  } catch (err) { return '📸 IG 權杖設定失敗：' + noTok_(err.message); }
}
function igPickPage_(u) {
  let pages = [];
  try { pages = JSON.parse(prop_('IG_PAGES') || '[]'); } catch (e) { pages = []; }
  const p = pages.filter(x => x.u === u)[0];
  if (!p) return null;
  ['IG_TOKEN', 'IG_USER', 'IG_NAME', 'IG_API', 'IG_TOKEN_AT'].forEach((k, i) => setProp_(k, [p.t, p.id, p.u, 'fb', String(Date.now())][i]));
  setProp_('IG_PAGES', '');
  return socSetDone_('IG @' + p.u);
}
function thSetToken_(tok) {
  tok = String(tok || '').trim();
  try {
    const res = UrlFetchApp.fetch('https://graph.threads.net/v1.0/me?fields=id,username&access_token=' + encodeURIComponent(tok), { muteHttpExceptions: true });
    let me = {}; try { me = JSON.parse(res.getContentText()); } catch (e) { me = {}; }
    if (me.error || !me.id) throw new Error(igErr_(me.error || { message: 'HTTP ' + res.getResponseCode() }));
    ['TH_TOKEN', 'TH_USER', 'TH_NAME', 'TH_TOKEN_AT'].forEach((k, i) => setProp_(k, [tok, String(me.id), me.username || '', String(Date.now())][i]));
    return socSetDone_('Threads @' + (me.username || ''));
  } catch (err) { return '🧵 Threads 權杖設定失敗：' + noTok_(err.message); }
}
// FB：給 Facebook 的使用者權杖（EAA… 開頭），找出你管理的粉專，存粉專權杖；有好幾個粉專就讓你選
function fbSetToken_(tok) {
  tok = String(tok || '').trim();
  try {
    const g = path => {
      const res = UrlFetchApp.fetch('https://graph.facebook.com/' + IG_VER + '/' + path + (path.indexOf('?') < 0 ? '?' : '&') + 'access_token=' + encodeURIComponent(tok), { muteHttpExceptions: true });
      let j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) { j = {}; }
      if (j.error) throw new Error(igErr_(j.error));
      return j;
    };
    // 短期權杖（大約 1 小時）換來的粉專權杖也會很快失效：先提醒去延長
    let warn = '';
    try {
      const d = g('debug_token?input_token=' + encodeURIComponent(tok)).data || {};
      if (d.expires_at && d.expires_at * 1000 - Date.now() < 3 * 86400000) warn = '\n\n⚠️ 這是短期權杖，粉專權杖很快會失效。請到「存取權杖偵錯工具」按「延長存取權杖」，把新的那串再設定一次。';
    } catch (e) { console.error(e); }
    const pages = (g('me/accounts?fields=name,access_token&limit=50').data || []).filter(p => p.access_token);
    if (!pages.length) return '📘 這個權杖找不到你管理的粉專。產生權杖時要勾 pages_show_list、pages_manage_posts，並選你的粉專。';
    setProp_('FB_PAGES', JSON.stringify(pages.map(p => ({ n: p.name, t: p.access_token, id: p.id }))));
    setProp_('FB_WARN', warn);
    if (pages.length === 1) return fbPickPage_(pages[0].name);
    return { text: '📘 你管理好幾個粉專，要發到哪一個？', buttons: chunk_(pages.map(p => '📘 粉專：' + p.name), 1) };
  } catch (err) { return '📘 FB 權杖設定失敗：' + noTok_(err.message); }
}
function fbPickPage_(name) {
  let pages = [];
  try { pages = JSON.parse(prop_('FB_PAGES') || '[]'); } catch (e) { pages = []; }
  const p = pages.filter(x => x.n === name)[0];
  if (!p) return null;
  ['FB_TOKEN', 'FB_PAGE', 'FB_NAME'].forEach((k, i) => setProp_(k, [p.t, p.id, p.n][i]));
  setProp_('FB_PAGES', '');
  const warn = prop_('FB_WARN'); setProp_('FB_WARN', '');
  const r = socSetDone_('FB 粉專「' + p.n + '」');
  r.text += warn;
  return r;
}
// 錯誤訊息裡如果帶了網址，把權杖遮掉，不要顯示在聊天裡
function noTok_(m) { return String(m || '').replace(/access_token=[^&\s]+/g, 'access_token=…').replace(/\b(EAA|IGAA|THAA)[A-Za-z0-9]{20,}/g, '$1…'); }
function socSetDone_(what) {
  const on = socOn_();
  return { text: '✅ ' + what + ' 設定好了。\n目前會發到：' + on.map(k => SOC[k].name + ' ' + SOC[k].who()).join('、') + '\n\n怎麼發：\n・智囊軍師的圖卡做好後，按「' + IG_BTN + '」\n・剪好的 Reels：長按小乖給的「📝 貼文文案參考」那則 →「回覆」打「發社群」\n・自己的照片或影片：傳給小乖時說明寫「發社群 文案…」\n每次都先給你看預覽，按「✅ 全部發」或「只發 …」才會發出去。', buttons: [[IG_BTN]].concat(QUICK) };
}
// IG、Threads 的權杖 60 天到期：每 7 天自動換新一次（提醒檢查時順便做）；FB 粉專權杖不會過期
function igRefresh_() {
  const renew = (tokK, atK, url) => {
    if (!prop_(tokK) || Date.now() - Number(prop_(atK) || 0) < 7 * 86400000) return;
    const res = UrlFetchApp.fetch(url + encodeURIComponent(prop_(tokK)), { muteHttpExceptions: true });
    let j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) { j = {}; }
    if (j.access_token) { setProp_(tokK, j.access_token); setProp_(atK, String(Date.now())); }
    else { console.error(tokK + ' 換新失敗：' + res.getContentText()); setProp_(atK, String(Date.now() - 6 * 86400000)); }   // 明天再試
  };
  if (prop_('IG_API') === 'ig') renew('IG_TOKEN', 'IG_TOKEN_AT', 'https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=');
  renew('TH_TOKEN', 'TH_TOKEN_AT', 'https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=');
}

/* ---- 要發什麼：記下剛做好的圖卡、預覽、確定 ---- */
// items：[{ t:'img'|'video', drive|tg: 檔案編號 }]
function igRemember_(files, cap) {
  const items = (files || []).filter(Boolean).slice(0, 10).map(f => ({ t: 'img', drive: f.getId() }));
  if (items.length) setProp_('IG_LAST', JSON.stringify({ items: items, cap: String(cap || '').slice(0, 2200), at: Date.now() }));
}
function igState_(k) { try { return JSON.parse(prop_(k) || 'null'); } catch (e) { return null; } }
function igWhat_(items) {
  const n = items.length;
  return items.some(x => x.t === 'video') ? '影片 1 支（IG 發成 Reels）' : n > 1 ? n + ' 張圖片（輪播）' : '1 張圖片';
}
function igNotReady_() {
  return { text: '📤 IG／Threads／FB 都還沒設定好。\n\n要先在 Meta 開發者網站建應用程式、產生權杖，再傳給小乖：\n・「設定 IG金鑰 權杖」\n・「設定 Threads金鑰 權杖」\n・「設定 FB金鑰 權杖」\n\n詳細步驟在 README 的「📤 發社群」，或直接問系統大師。', buttons: QUICK };
}
// Threads 一則 500 字：太長就從最後一行往前砍
function thText_(cap) {
  cap = String(cap || '').trim();
  if (cap.length <= TH_MAX) return cap;
  const lines = cap.split('\n');
  while (lines.length > 1 && lines.join('\n').length > TH_MAX - 1) lines.pop();
  const t = lines.join('\n').trim();
  return (t.length > TH_MAX - 1 ? t.slice(0, TH_MAX - 1) : t) + '…';
}
function igPreview_(post) {
  if (!socOn_().length) return igNotReady_();
  if (!post || !post.items || !post.items.length) return { text: '📤 目前沒有要發的內容。先做圖卡（🪶 智囊軍師），或傳照片／影片時說明寫「發社群」。', buttons: QUICK };
  if (post.items.some(x => x.t === 'video') && post.items.length > 1) post.items = post.items.filter(x => x.t === 'video').slice(0, 1);
  const on = socFor_(post);
  if (!on.length) return { text: '📤 TikTok 只能送影片（圖卡、照片不行）。剪好的 Reels 或自己的影片才能發到 TikTok。', buttons: QUICK };
  post.at = Date.now();
  setProp_('IG_PENDING', JSON.stringify(post));
  const cap = String(post.cap || '').trim();
  const btns = on.length > 1 ? [['✅ 全部發（' + socNames_(on) + '）'], on.map(k => '只發 ' + SOC[k].name), [IG_NO]] : [['✅ 確定發 ' + SOC[on[0]].name, IG_NO]];
  return { text: '📤 準備發文\n發到：' + on.map(k => SOC[k].name + ' ' + SOC[k].who()).join('、') + '\n內容：' + igWhat_(post.items)
    + '\n\n文案：\n' + (cap ? (cap.length > 600 ? cap.slice(0, 600) + '…（共 ' + cap.length + ' 字）' : cap) : '（沒有文案）')
    + (on.indexOf('th') >= 0 && cap.length > TH_MAX ? '\n\n（Threads 一則最多 500 字，會自動截短）' : '')
    + (on.indexOf('tk') >= 0 ? '\n\n（TikTok 會送到草稿匣：打開 TikTok 的通知，加音樂、貼文案再發佈）' : '')
    + '\n\n要發到哪裡？要換文案就打「發文文案 」加上新的文案。', buttons: btns };
}
// answer_ 用（LINE、Telegram、對話頁都會經過）
function igAsk_(t, raw) {
  const k = String(t || '').replace(/\s+/g, ''), r = String(raw || t);
  const tk = r.match(/^\s*設定\s*(IG|Instagram|Threads|脆|FB|Facebook|臉書|粉專)\s*(?:金鑰|權杖|token)\s*(\S+)\s*$/i);
  if (tk) return /^(IG|Instagram)$/i.test(tk[1]) ? igSetToken_(tk[2]) : /^(Threads|脆)$/i.test(tk[1]) ? thSetToken_(tk[2]) : fbSetToken_(tk[2]);
  const tkk = r.match(/^\s*設定\s*(?:TK|TikTok|抖音)\s*(?:金鑰|權杖|key)\s*(\S+)\s+(\S+)\s*$/i);
  if (tkk) return tkSetKey_(tkk[1], tkk[2]);
  if (/^(TK|TikTok)(設定|連結|登入|重新連結)$/i.test(k)) return tkLink_();
  const ik = r.match(/^\s*📸 IG：@(\S+)\s*$/);
  if (ik) { const x = igPickPage_(ik[1]); if (x) return x; }
  const pk = r.match(/^\s*📘 粉專：(.+?)\s*$/);
  if (pk) { const x = fbPickPage_(pk[1]); if (x) return x; }
  if (/^(IG|ig|社群|發文|Threads|FB)(設定|狀態)$/i.test(k)) {
    const on = socOn_();
    return on.length ? '📤 已設定：' + on.map(x => SOC[x].name + ' ' + SOC[x].who()).join('、') + (on.length < Object.keys(SOC).length ? '\n還沒設定：' + Object.keys(SOC).filter(x => on.indexOf(x) < 0).map(x => SOC[x].name).join('、') : '') : igNotReady_();
  }
  const pend = igState_('IG_PENDING'), live = pend && Date.now() - pend.at < 30 * 60 * 1000;
  const go = k.match(/^(?:確定發|全部發|只發)(.*)$/);
  if (go && (pend || /^(確定發|全部發)/.test(k))) {
    const sent = igState_('IG_JOB');   // 防呆：剛按過「全部發」，第二下不要說過期
    if (!live && sent && Date.now() - (sent.at || 0) < 30 * 60 * 1000) return '⏳ 這則已經在發了，好了會傳連結給你，不用再按喔。';
    if (!live) return { text: '📤 要發的內容已經過期了（超過 30 分鐘），再按一次「' + IG_BTN + '」。', buttons: [[IG_BTN]].concat(QUICK) };
    const on = socFor_(pend);
    if (!on.length) return igNotReady_();
    const want = /^只發/.test(k) ? on.filter(x => new RegExp('^' + SOC[x].name + '$', 'i').test(go[1])) : on;
    if (!want.length) return igPreview_(pend);
    // 防呆：連按兩次「全部發」時，第二次看到已經排好就不再發一次
    const dup = withLock_(() => {
      const busy = igState_('IG_JOB'), p2 = igState_('IG_PENDING');
      if (busy && Date.now() - (busy.at || 0) < 30 * 60 * 1000) return '⏳ 上一則還在發，等它好了再按一次。';
      if (!p2 || p2.at !== pend.at) return '⏳ 這則已經在發了，好了會傳連結給你，不用再按喔。';
      setProp_('IG_PENDING', '');
      pend.targets = want;
      igQueue_(pend);
      return '';
    });
    if (dup) return dup;
    return '⏳ 正在發到 ' + socNames_(want) + (pend.items.some(x => x.t === 'video') ? '，平台處理影片要一點時間（通常 1～3 分鐘）' : '') + '，好了傳連結給你。';
  }
  if (live && /^(不發|不要發|取消發文)$/.test(k)) { setProp_('IG_PENDING', ''); return { text: '好，不發了。', buttons: QUICK }; }
  const cm = r.match(/^\s*(?:發文|IG|ig|社群)\s*文案[\s：:]*([\s\S]+)$/);
  if (cm && live) { pend.cap = cm[1].trim().slice(0, 2200); return igPreview_(pend); }
  const m = String(t || '').match(IG_WORD);
  if (!m) return null;
  const last = igState_('IG_LAST');
  if (!last) return igPreview_(null);
  const extra = String(t).slice(m[0].length).replace(/^[\s：:]+/, '').trim();
  if (extra) last.cap = extra;
  return igPreview_(last);
}
// Telegram：自己傳的照片／影片說明寫「發社群」，或回覆小乖給的影片／照片／「📝 貼文文案參考」打「發社群」
function igTg_(msg, text) {
  const m = String(text || '').replace(/^[^\p{L}\p{N}]+/u, '').match(IG_WORD);
  if (!m) return null;
  const pick = x => {
    if (!x) return null;
    if (x.photo && x.photo.length) return { t: 'img', tg: x.photo[x.photo.length - 1].file_id };
    if (x.document && /^image\//.test(x.document.mime_type || '')) return { t: 'img', tg: x.document.file_id };
    const v = x.video || (x.document && /^video\//.test(x.document.mime_type || '') ? x.document : null);
    if (v) return { t: 'video', tg: v.file_id, size: v.file_size || 0 };
    // 剪 Reels 的「📝 貼文文案參考」：影片編號藏在「📤 要發到…」那行的連結裡
    const ents = (x.entities || []).concat(x.caption_entities || []);
    const link = ents.map(e => e.url || '').filter(u => /[?&]igv=/.test(u))[0];
    if (link) return { t: 'video', tg: decodeURIComponent(link.split(/[?&]igv=/)[1].split('&')[0]) };
    return null;
  };
  const rt = msg.reply_to_message;
  const own = pick(msg), item = own || pick(rt);
  if (!item) return null;   // 只打字：交給 answer_ 用剛做好的圖卡
  const extra = String(text).replace(/^[^\p{L}\p{N}]+/u, '').slice(m[0].length).replace(/^[\s：:]+/, '').trim();
  let cap = extra;
  if (!cap && !own && rt) {
    const body = String(rt.text || rt.caption || '');
    if (/^📝/.test(body)) cap = body.replace(/^📝[^\n]*\n+/, '').replace(/\n*📤 要發到[\s\S]*$/, '').trim();
  }
  if (item.t === 'video' && item.size > 20 * 1024 * 1024) return '🎬 這支影片超過 20MB，Telegram 不讓小乖下載，沒辦法幫你發。可以先存到手機，用 App 發。';
  return igPreview_({ items: [item], cap: cap });
}

/* ---- 真正發文：交給另一次執行（觸發條件），影片處理比較久，沒好就 1 分鐘後再看 ---- */
function igQueue_(post) {
  const to = LINE_MODE_ ? { p: 'line', to: prop_('OWNER_USER_ID') } : { p: 'tg', to: CURRENT_TG_CHAT_ || prop_('TG_OWNER_CHAT_ID') };
  if (!to.to) { to.p = prop_('TG_OWNER_CHAT_ID') ? 'tg' : 'line'; to.to = prop_('TG_OWNER_CHAT_ID') || prop_('OWNER_USER_ID'); }
  setProp_('IG_JOB', JSON.stringify(Object.assign({ tries: 0, res: {} }, post, to, { at: Date.now() })));
  igSchedule_(1000);
}
function igSchedule_(ms) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'igJob').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('igJob').timeBased().after(ms).create();
}
function igTell_(job, text) {
  if (job.p === 'line') lineApi_('push', { to: job.to, messages: withQuick_([{ type: 'text', text: text }], QUICK) });
  else tgSend_(job.to, text);
}
function igJob() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'igJob').forEach(t => ScriptApp.deleteTrigger(t));
  const job = igState_('IG_JOB');
  if (!job) return;
  const start = Date.now(), save = () => setProp_('IG_JOB', JSON.stringify(job));
  job.res = job.res || {};
  try {
    if (!job.media) { job.media = socMedia_(job); save(); }
  } catch (err) {
    console.error('發文準備失敗：' + err.message);
    setProp_('IG_JOB', '');
    igCleanup_(job);
    return igTell_(job, '📤 這次沒發出去：' + String(err.message).slice(0, 300) + '\n\n可以再按一次「' + IG_BTN + '」試試。');
  }
  for (const t of job.targets) {
    const r = job.res[t] = job.res[t] || {};
    if (r.link !== undefined || r.err) continue;
    try {
      if (t === 'fb') { r.link = fbPost_(job); save(); continue; }
      if (t === 'tk') { tkPost_(job); r.link = '已送到草稿匣，打開 TikTok 的通知，加音樂、貼文案再發佈'; save(); continue; }
      if (!r.c) { r.c = t === 'ig' ? igCreate_(job) : thCreate_(job); save(); }
      let st = '';
      while (Date.now() - start < 4 * 60 * 1000) {
        st = socStatus_(t, r.c);
        if (st !== 'IN_PROGRESS') break;
        Utilities.sleep(job.media[0].t === 'video' ? 10000 : 3000);
      }
      if (st === 'IN_PROGRESS') {
        job.tries = (job.tries || 0) + 1;
        if (job.tries > 6) throw new Error('平台處理太久（超過 25 分鐘）還沒好');
        save();
        return igSchedule_(60 * 1000);
      }
      if (st !== 'FINISHED') throw new Error(st);
      r.link = t === 'ig' ? igPublish_(r.c) : thPublish_(r.c);
      save();
    } catch (err) {
      console.error(t + ' 發文失敗：' + err.message);
      r.err = String(err.message).slice(0, 200);
      save();
    }
  }
  setProp_('IG_JOB', '');
  igCleanup_(job);
  const ok = job.targets.filter(t => !job.res[t].err), bad = job.targets.filter(t => job.res[t].err);
  igTell_(job, (ok.length ? '🎉 發好了！\n' + ok.map(t => '・' + SOC[t].name + (job.res[t].link ? '：' + job.res[t].link : '') ).join('\n') : '📤 這次都沒發出去。')
    + (bad.length ? '\n\n沒發出去：\n' + bad.map(t => '・' + SOC[t].name + '：' + job.res[t].err).join('\n') + '\n要重發就再按一次「' + IG_BTN + '」選「只發 …」。' : ''));
}

// 先把要發的檔案準備好：圖片轉 JPG（IG 只收 JPG）、影片原檔，暫存到雲端硬碟（知道連結的人都能看，平台才抓得到），發完就刪
function socMedia_(job) {
  const it = DriveApp.getFoldersByName(IG_FOLDER);
  const dir = it.hasNext() ? it.next() : DriveApp.createFolder(IG_FOLDER);
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss');
  job.temp = [];
  return job.items.map((x, i) => {
    const src = x.drive ? DriveApp.getFileById(x.drive).getBlob() : igTgBlob_(x.tg, x.t === 'video' ? '影片' : '圖片');
    const blob = x.t === 'video' ? src.setName('發文_' + stamp + '.mp4') : src.getAs('image/jpeg').setName('發文_' + stamp + '_' + (i + 1) + '.jpg');
    const f = dir.createFile(blob);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    job.temp.push(f.getId());
    return { t: x.t, id: f.getId() };
  });
}
function socUrl_(m, alt) {
  if (m.t === 'video') return 'https://drive.usercontent.google.com/download?id=' + m.id + '&export=download&confirm=t';
  return alt ? 'https://drive.google.com/uc?export=download&id=' + m.id : 'https://lh3.googleusercontent.com/d/' + m.id;
}
// 平台抓不到 lh3 的網址就改用雲端硬碟下載網址再試一次
function socTry_(fn) {
  try { return fn(false); } catch (e) { if (!/抓不到/.test(e.message)) throw e; return fn(true); }
}
function socStatus_(t, id) {
  if (t === 'ig') {
    const s = igCall_('get', id, { fields: 'status_code,status' });
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') return '處理失敗：' + igStatusErr_(s.status);
    return s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED' ? 'FINISHED' : 'IN_PROGRESS';
  }
  const s = thCall_('get', id, { fields: 'status,error_message' });
  if (s.status === 'ERROR' || s.status === 'EXPIRED') return '處理失敗：' + (s.error_message || s.status);
  return s.status === 'FINISHED' || s.status === 'PUBLISHED' ? 'FINISHED' : 'IN_PROGRESS';
}
function igStatusErr_(s) {
  s = String(s || '');
  if (/2207026/.test(s)) return '影片格式不符合 Reels（要 MP4、3 秒到 15 分鐘）';
  if (/2207009/.test(s)) return '比例不符合';
  return s.slice(0, 160) || '原因不明';
}

// IG：影片走 Reels 直接上傳檔案；圖片給網址（單張或輪播）
function igCreate_(job) {
  const ig = prop_('IG_USER'), cap = String(job.cap || '').slice(0, 2200), md = job.media;
  if (md[0].t === 'video') {
    const c = igCall_('post', ig + '/media', { media_type: 'REELS', upload_type: 'resumable', caption: cap, share_to_feed: 'true' });
    const bytes = DriveApp.getFileById(md[0].id).getBlob().getBytes();
    const res = UrlFetchApp.fetch('https://rupload.facebook.com/ig-api-upload/' + IG_VER + '/' + c.id, {
      method: 'post', muteHttpExceptions: true, contentType: 'application/octet-stream', payload: bytes,
      headers: { Authorization: 'OAuth ' + prop_('IG_TOKEN'), offset: '0', file_size: String(bytes.length) } });
    if (res.getResponseCode() !== 200) {
      let e = {}; try { e = JSON.parse(res.getContentText()); } catch (x) { e = {}; }
      throw new Error('影片上傳失敗：' + (e.debug_info ? e.debug_info.message : e.error ? igErr_(e.error) : res.getContentText().slice(0, 160)));
    }
    return c.id;
  }
  const one = (m, extra) => socTry_(alt => igCall_('post', ig + '/media', Object.assign({ image_url: socUrl_(m, alt) }, extra)).id);
  if (md.length === 1) return one(md[0], { caption: cap });
  const kids = md.map(m => one(m, { is_carousel_item: 'true' }));
  return igCall_('post', ig + '/media', { media_type: 'CAROUSEL', children: kids.join(','), caption: cap }).id;
}
function igPublish_(c) {
  const pub = igCall_('post', prop_('IG_USER') + '/media_publish', { creation_id: c });
  try { return igCall_('get', pub.id, { fields: 'permalink' }).permalink || ''; } catch (e) { console.error(e); return ''; }
}
// Threads：圖片、影片都給網址；最多 500 字
function thCreate_(job) {
  const th = prop_('TH_USER'), text = thText_(job.cap), md = job.media;
  const one = (m, extra) => socTry_(alt => thCall_('post', th + '/threads', Object.assign(m.t === 'video'
    ? { media_type: 'VIDEO', video_url: socUrl_(m, alt) } : { media_type: 'IMAGE', image_url: socUrl_(m, alt) }, extra)).id);
  if (md.length === 1) return one(md[0], text ? { text: text } : {});
  const kids = md.map(m => one(m, { is_carousel_item: 'true' }));
  return thCall_('post', th + '/threads', Object.assign({ media_type: 'CAROUSEL', children: kids.join(',') }, text ? { text: text } : {})).id;
}
function thPublish_(c) {
  const pub = thCall_('post', prop_('TH_USER') + '/threads_publish', { creation_id: c });
  try { return thCall_('get', pub.id, { fields: 'permalink' }).permalink || ''; } catch (e) { console.error(e); return ''; }
}
// FB 粉專：檔案直接上傳（不用網址）；多張照片先上傳不發布，再合成一則貼文
/* ---- TikTok：影片送到草稿匣（Content Posting API，video.upload；不用審核，只能發自己的帳號） ---- */
const TK_API = 'https://open.tiktokapis.com/v2/';
function tkRedirect_() { return ScriptApp.getService().getUrl(); }
function tkSetKey_(key, secret) {
  setProp_('TK_KEY', key);
  setProp_('TK_SECRET', secret);
  return tkLink_();
}
// 登入連結：按了用 TikTok 帳號允許，TikTok 會帶著一次性的碼回到小乖（doGet → tkCallback_）
function tkLink_() {
  if (!prop_('TK_KEY')) return '🎵 TikTok 還沒設定：先在 TikTok for Developers 建應用程式，Login Kit 的 Redirect URI 填：\n' + tkRedirect_()
    + '\n\n建好後傳「設定 TK金鑰 Client key Client secret」（兩串中間空一格）。步驟在 README 的「TikTok」。';
  const state = Utilities.getUuid().replace(/-/g, '');
  setProp_('TK_STATE', state + '|' + Date.now());
  const url = 'https://www.tiktok.com/v2/auth/authorize/?client_key=' + encodeURIComponent(prop_('TK_KEY'))
    + '&scope=' + encodeURIComponent('user.info.basic,video.upload') + '&response_type=code'
    + '&redirect_uri=' + encodeURIComponent(tkRedirect_()) + '&state=' + state;
  return '🎵 TikTok 金鑰收到了。\n\n① 先確認應用程式的 Redirect URI 填的是：\n' + tkRedirect_()
    + '\n\n② 再打開這個連結，用你的 TikTok 帳號按「允許」（10 分鐘內有效）：\n' + url;
}
function tkCallback_(p) {
  const st = String(prop_('TK_STATE') || '').split('|');
  const page = msg => HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font:18px/1.7 sans-serif;padding:32px 20px">' + msg + '</div>').setTitle('小乖 TikTok');
  if (!st[0] || p.state !== st[0] || Date.now() - Number(st[1] || 0) > 10 * 60 * 1000) return page('🎵 這個連結過期了，請在小乖打「TK設定」拿新的連結。');
  setProp_('TK_STATE', '');
  if (p.error) return page('🎵 沒有連上 TikTok：' + String(p.error_description || p.error).replace(/[<>]/g, ''));
  try {
    tkSaveToken_(tkTokenCall_({ grant_type: 'authorization_code', code: String(p.code), redirect_uri: tkRedirect_() }));
  } catch (e) {
    return page('🎵 連接 TikTok 失敗：' + String(e.message).replace(/[<>]/g, '').slice(0, 200));
  }
  const tg = prop_('TG_OWNER_CHAT_ID');
  if (tg) tgSend_(tg, '🎵 TikTok 連好了！之後剪好的 Reels 或自己的影片按「發社群」，可以一起送到 TikTok 草稿匣。');
  return page('✅ TikTok 連好了，可以關掉這頁回到小乖。');
}
function tkTokenCall_(params) {
  const res = UrlFetchApp.fetch(TK_API + 'oauth/token/', { method: 'post', muteHttpExceptions: true,
    contentType: 'application/x-www-form-urlencoded',
    payload: Object.assign({ client_key: prop_('TK_KEY'), client_secret: prop_('TK_SECRET') }, params) });
  let j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) { j = {}; }
  if (!j.access_token) throw new Error(j.error_description || j.error || ('TikTok 回應 ' + res.getResponseCode()));
  return j;
}
function tkSaveToken_(j) {
  setProp_('TK_TOKEN', j.access_token);
  setProp_('TK_EXP', String(Date.now() + (Number(j.expires_in) || 86400) * 1000 - 5 * 60 * 1000));
  if (j.refresh_token) setProp_('TK_REFRESH', j.refresh_token);
}
// 權杖 24 小時到期，過期就用 refresh_token（一年有效）換新
function tkToken_() {
  if (prop_('TK_TOKEN') && Date.now() < Number(prop_('TK_EXP') || 0)) return prop_('TK_TOKEN');
  try { tkSaveToken_(tkTokenCall_({ grant_type: 'refresh_token', refresh_token: prop_('TK_REFRESH') })); }
  catch (e) { throw new Error('TikTok 登入過期了，請打「TK設定」重新連結（' + e.message + '）'); }
  return prop_('TK_TOKEN');
}
function tkPost_(job) {
  const m = job.media.filter(x => x.t === 'video')[0];
  if (!m) throw new Error('TikTok 只能送影片');
  const bytes = DriveApp.getFileById(m.id).getBlob().getBytes(), n = bytes.length;
  const init = UrlFetchApp.fetch(TK_API + 'post/publish/inbox/video/init/', { method: 'post', muteHttpExceptions: true,
    contentType: 'application/json; charset=UTF-8', headers: { Authorization: 'Bearer ' + tkToken_() },
    payload: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: n, chunk_size: n, total_chunk_count: 1 } }) });
  let j = {}; try { j = JSON.parse(init.getContentText()); } catch (e) { j = {}; }
  const up = j.data && j.data.upload_url;
  if (!up) throw new Error((j.error && (j.error.message || j.error.code)) || ('TikTok 回應 ' + init.getResponseCode()));
  const put = UrlFetchApp.fetch(up, { method: 'put', muteHttpExceptions: true, contentType: 'video/mp4',
    headers: { 'Content-Range': 'bytes 0-' + (n - 1) + '/' + n }, payload: bytes });
  if (put.getResponseCode() >= 300) throw new Error('影片上傳失敗（' + put.getResponseCode() + '）');
  return j.data.publish_id;
}
function fbPost_(job) {
  const pg = prop_('FB_PAGE'), cap = String(job.cap || ''), md = job.media;
  const blob = m => DriveApp.getFileById(m.id).getBlob();
  if (md[0].t === 'video') {
    const v = fbCall_('post', pg + '/videos', { source: blob(md[0]), description: cap }, true);
    return 'https://www.facebook.com/' + v.id;
  }
  if (md.length === 1) {
    const p = fbCall_('post', pg + '/photos', { source: blob(md[0]), message: cap });
    return 'https://www.facebook.com/' + (p.post_id || p.id);
  }
  const ids = md.map(m => fbCall_('post', pg + '/photos', { source: blob(m), published: 'false' }).id);
  const params = { message: cap };
  ids.forEach((id, i) => { params['attached_media[' + i + ']'] = JSON.stringify({ media_fbid: id }); });
  return 'https://www.facebook.com/' + fbCall_('post', pg + '/feed', params).id;
}
function igTgBlob_(fileId, what) {
  const info = JSON.parse(tgApi_('getFile', { file_id: fileId }));
  if (!info.ok) throw new Error(what + '超過 20MB 或已失效，Telegram 不讓小乖下載');
  const res = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_BOT_TOKEN') + '/' + info.result.file_path, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(what + '下載失敗');
  return res.getBlob();
}
function igCleanup_(job) {
  (job && job.temp || []).forEach(id => { try { const f = DriveApp.getFileById(id); f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); f.setTrashed(true); } catch (e) { console.error(e); } });
}


/* ============ 🕗 自動發文：每天晚上自動做一組智囊軍師 7 張圖卡，發到社群 ============ */
// 2026-10-17 使用者：用智囊軍師的 7 張圖卡自動發，五大主題照現在的順序輪流，時間在 20:00～21:30 之間
// 打「自動發文 開」建立每天 20:30 左右（Apps Script 前後 15 分鐘內）的觸發條件；「自動發文 關」停掉；「自動發文」看狀態
const AUTO_ORDER = ['concept', 'health', 'herb', 'biz', 'net'];   // 觀念 → 健康 → 草本 → 經營 → 行銷（跟軍師按鈕順序一樣）
const AUTO_HOUR = 20, AUTO_MIN = 30;

function autoTheme_(i) { const k = AUTO_ORDER[(Number(i) || 0) % AUTO_ORDER.length]; return STRAT_THEMES.filter(t => t.k === k)[0]; }
function autoName_(th) { return th ? th.btn.replace(/^[^\p{L}\p{N}]+/u, '') : ''; }
function autoTriggers_() { return ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'autoPostJob'); }
function autoStatus_() {
  const on = prop_('AUTO_POST') === 'on';
  const next = autoTheme_(prop_('AUTO_IDX'));
  const plat = socFor_({ items: [{ t: 'img' }] });
  return { text: '🕗 自動發文：' + (on ? '開著' : '關著')
    + '\n時間：每天 20:15～20:45 之間'
    + '\n內容：智囊軍師 7 張圖卡＋貼文（PDF 一起傳給你）'
    + '\n主題輪流：' + AUTO_ORDER.map(k => autoName_(autoTheme_(AUTO_ORDER.indexOf(k)))).join(' → ')
    + '\n下一篇：' + autoName_(next)
    + '\n發到：' + (plat.length ? socNames_(plat) : '（還沒設定社群）')
    + '\n\n「自動發文 開」／「自動發文 關」；要換下一篇的主題，打「下一篇 健康」這樣。', buttons: [[on ? '自動發文 關' : '自動發文 開']].concat(QUICK) };
}
// answer_ 用：自動發文 開／關／狀態、下一篇 主題
function autoAsk_(t) {
  const k = String(t || '').replace(/\s+/g, '');
  const nx = k.match(/^下一篇(?:主題)?[：:]?(\S+)$/);
  if (nx) {
    const i = AUTO_ORDER.findIndex(x => autoName_(autoTheme_(AUTO_ORDER.indexOf(x))) === nx[1].replace(/主題$/, ''));
    if (i < 0) return null;
    setProp_('AUTO_IDX', String(i));
    return autoStatus_();
  }
  const m = k.match(/^(?:自動發文|自動發佈|自動發布|排程發文)(開|開啟|打開|關|關閉|停|停止|狀態)?$/);
  if (!m) return null;
  const v = m[1] || '狀態';
  if (/^(開|開啟|打開)$/.test(v)) {
    if (!socFor_({ items: [{ t: 'img' }] }).length) return { text: '🕗 要先設定好 IG 或 FB（「設定 IG金鑰」「設定 FB金鑰」），才能自動發文。', buttons: QUICK };
    autoTriggers_().forEach(x => ScriptApp.deleteTrigger(x));
    ScriptApp.newTrigger('autoPostJob').timeBased().everyDays(1).atHour(AUTO_HOUR).nearMinute(AUTO_MIN).inTimezone(TZ).create();
    setProp_('AUTO_POST', 'on');
    return autoStatus_();
  }
  if (/^(關|關閉|停|停止)$/.test(v)) {
    autoTriggers_().forEach(x => ScriptApp.deleteTrigger(x));
    setProp_('AUTO_POST', '');
    return autoStatus_();
  }
  return autoStatus_();
}
// 觸發條件呼叫：寫文案 → 畫 7 張圖卡＋PDF（傳給你一份）→ 發到有設定的社群（IG、FB、Threads；TikTok 只收影片不發）
function autoPostJob() {
  if (prop_('AUTO_POST') !== 'on') return;
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (prop_('AUTO_DAY') === today) return;   // 一天只發一篇（重試的那次也不會重複）
  const tg = prop_('TG_OWNER_CHAT_ID'), line = prop_('OWNER_USER_ID');
  const tell = text => tg ? tgSend_(tg, text) : line && lineApi_('push', { to: line, messages: [{ type: 'text', text: text }] });
  // 上一次排的「5 分鐘後再試」觸發條件用完就刪掉（每天那個不動）
  const rid = prop_('AUTO_RETRY_ID');
  if (rid) { autoTriggers_().filter(x => x.getUniqueId() === rid).forEach(x => ScriptApp.deleteTrigger(x)); setProp_('AUTO_RETRY_ID', ''); }
  const retry = () => setProp_('AUTO_RETRY_ID', ScriptApp.newTrigger('autoPostJob').timeBased().after(5 * 60 * 1000).create().getUniqueId());
  // 你剛好在做 7張＋PDF，或上一則還在發：5 分鐘後再來
  const job = igState_('IG_JOB');
  if ((job && Date.now() - (job.at || 0) < 30 * 60 * 1000) || busy_('KIT_BUSY', 10 * 60 * 1000)) return retry();
  setProp_('AUTO_DAY', today);
  const i = Number(prop_('AUTO_IDX')) || 0, th = autoTheme_(i);
  try {
    if (tg) { LINE_MODE_ = false; CURRENT_TG_CHAT_ = tg; } else { LINE_MODE_ = true; CURRENT_TG_CHAT_ = ''; }
    setProp_('IG_LAST', '');
    const w = kitWrite_(th.k);
    if (!LAST_KIT_) throw new Error(String(w && w.text || w).slice(0, 120));
    LAST_KIT_.style = prop_('AUTO_STYLE') || KIT_STYLES[0].n;
    tell('🕗 自動發文：今天的主題是「' + autoName_(th) + '」，圖卡和 PDF 在下面，接著發到社群。');
    if (tg) kitTg_(tg); else kitLine_(line);
    const post = igState_('IG_LAST');
    if (!post || !post.items || !post.items.length) throw new Error('圖卡沒畫出來');
    post.targets = socFor_(post);
    if (!post.targets.length) throw new Error('還沒設定 IG 或 FB');
    setProp_('AUTO_IDX', String(i + 1));   // 成功做出圖卡才換下一個主題
    igQueue_(post);
  } catch (err) {
    console.error('自動發文失敗：' + err.message);
    tell('🕗 今天的自動發文（' + autoName_(th) + '）沒做成：' + noTok_(err.message) + '\n明天會再試同一個主題；想現在補發，按「📕 7張＋PDF」做好後按「📤 發社群」。');
  } finally { busyEnd_('KIT_BUSY'); }
}
