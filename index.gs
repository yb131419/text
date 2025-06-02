// === 設定區 ===
const CONFIG = {
  sheetId: "1Y9DeYEBYLalwneLYuOKl1pIkQFXk7lpGvGIevsMlgYM",
  accessToken: "niPmV23/WqVWkNFWOIJ4mMeGqLAKjRSaQUjCw1pPJz8keZxgPnhuWVTKsC+Y5qE+S93DIvq7PGrwXtcPI6yyiMzYqIr7SV9ONosrQDq+lLlS4QjZvaVZ0n78FlhRGNhdW6G7jJ354AP6WzDfQMjQwAdB04t89/1O/w1cDnyilFU=",
  openAiApiKey: "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",
  adminId: "Ub4aaa93e6ecee26d33ddd9154d688233"
};

// === 主流程 ===
function doGet(e) {
  if (e.parameter.testDailyPost) {
    scheduledDailyPost();
    return textOutput("每日推播已執行");
  }
  return handleGetProducts();
}

// Webhook 接收使用者訊息
function doPost(e) {
  const json = JSON.parse(e.postData.contents);
  const events = json.events;

  events.forEach(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const userMessage = event.message.text;
      const timestamp = new Date();

      // 寫入 Google Sheet
      recordUserResponse(userId, userMessage, timestamp);

      // 自動回覆使用者（可選）
      replyToUser(userId, '感謝你的回覆，我們會盡快與你聯繫。');
    }
  });

  return ContentService.createTextOutput('OK');
}

// 寫入使用者訊息到 Google Sheet
function recordUserResponse(userId, message, timestamp) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName('Responses');
  if (!sheet) {
    const ss = SpreadsheetApp.openById(CONFIG.sheetId);
    sheet = ss.insertSheet('Responses');
    sheet.appendRow(['時間', 'User ID', '使用者訊息']);
  }

  sheet.appendRow([timestamp, userId, message]);
}

// 回覆訊息給使用者（可選）
function replyToUser(userId, text) {
  const url = 'https://api.line.me/v2/bot/message/push';

  const payload = {
    to: userId,
    messages: [{
      type: 'text',
      text: text
    }]
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CONFIG.accessToken
    },
    payload: JSON.stringify(payload)
  });
}


// ➤ 群發 Flex 卡片（含圖片與按鈕）
function broadcastAndTriggerFollowUp() {
  const url = 'https://api.line.me/v2/bot/message/broadcast';
  const messageText = '📩 今天的健康主題已送達，點我了解更多！';

  const payload = {
    messages: [
      {
        type: 'text',
        text: messageText
      }
    ]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.accessToken
    },
    payload: JSON.stringify(payload)
  };

  const response = UrlFetchApp.fetch(url, options);
  const result = response.getContentText();

  Logger.log("Broadcast sent: " + result);

  // 🧠 這裡就可以接著執行你想做的事，例如記錄、寫入 Sheet、Log、更新狀態
  followUpAfterBroadcast(messageText);
}

function followUpAfterBroadcast(messageText) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("BroadcastLog");
  if (!sheet) {
    SpreadsheetApp.openById(CONFIG.sheetId).insertSheet("BroadcastLog");
  }
  SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("BroadcastLog")
    .appendRow([new Date(), messageText, "已群發並完成後續處理"]);
}


// ➤ 加到 Google Sheet 自訂選單
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('LINE 群發')
    .addItem('群發 Flex 卡片', 'broadcastFlexCard')
    .addItem('群發文字訊息', 'broadcastTextMessage')
    .addToUi();
}


// POST 請求入口
function doPost(e) {
  return handlePostEvent(JSON.parse(e.postData.contents));
}

// 將使用者資料記錄到 Sheet3_liffId
function recordUserToSheet3(userId, displayName, liffId, lastMessage) {
  const ss = SpreadsheetApp.openById(CONFIG.sheetId);
  const sheetName = `Sheet3_${liffId}`;
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['Timestamp', 'UserId', 'DisplayName', 'LIFF ID', 'LastMessage']);
  }
  const data = sheet.getDataRange().getValues();
  const foundIndex = data.findIndex(row => row[1] === userId);
  const now = new Date();
  if (foundIndex > 0) {
    sheet.getRange(foundIndex + 1, 1).setValue(now);
    sheet.getRange(foundIndex + 1, 3).setValue(displayName);
    sheet.getRange(foundIndex + 1, 4).setValue(liffId);
    sheet.getRange(foundIndex + 1, 5).setValue(lastMessage);
  } else {
    sheet.appendRow([now, userId, displayName, liffId, lastMessage]);
  }
}

// 群發 Flex Message 給所有人
function broadcastToAll(flexContent) {
  const url = 'https://api.line.me/v2/bot/message/broadcast';
  const payload = {
    messages: [
      {
        type: 'flex',
        altText: '請查看內容',
        contents: flexContent
      }
    ]
  };
  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CONFIG.accessToken
    },
    payload: JSON.stringify(payload)
  });
}

// JSON 輸出
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ✅ 單人推播
function sendPushToUser(userId, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + CONFIG.accessToken,
    },
    payload: JSON.stringify({
      to: userId,
      messages: [
        {
          type: 'text',
          text: text,
        },
      ],
    }),
  });
}

// ✅ 全體推播（Broadcast）
function sendBroadcast(text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + CONFIG.accessToken,
    },
    payload: JSON.stringify({
      messages: [
        {
          type: 'text',
          text: text,
        },
      ],
    }),
  });
}

// ✅ 指定場景名稱（scene）推播
function sendPushToScene(sceneName, text) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet3");
  const rows = sheet.getDataRange().getValues();
  const userIds = new Set();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][4] === sceneName) { // 第5欄是 scene
      userIds.add(rows[i][1]); // 第2欄是 userId
    }
  }
  for (let userId of userIds) {
    sendPushToUser(userId, text);
  }
}

// ✅ 從 Sheet 指定範圍推播（例如選到哪些人）
function sendPushFromSheetRange(startRow, endRow, message) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet3");
  for (let i = startRow - 1; i < endRow; i++) {
    const userId = sheet.getRange(i + 1, 2).getValue(); // 第2欄 userId
    if (userId) {
      sendPushToUser(userId, message);
    }
  }
}

// === 模組化處理區 ===
function handleGetProducts() {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet3");
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return jsonOutput([]);
    const products = data.slice(1).map(row => ({
      name: row[0]?.toString().trim(),
      displayName: row[0]?.toString().trim(),
      pv: parseFloat(row[2]) || 0,
      price: parseFloat(row[3]) || 0
    }));
    return jsonOutput(products);
  } catch (err) {
    console.error("handleGetProducts error:", err);
    return textOutput("Error");
  }
}

function handlePostEvent(body) {
  try {
    const event = body.events[0];
    if (!event || event.type !== "message" || event.message.type !== "text") {
      return textOutput("ignore non-text");
    }
    logEvent(event);
    const msg = event.message.text.trim();
    const replyToken = event.replyToken;
    const userId = event.source.userId;
    const presetMenus = {
      "看得見": () => sendCarouselMenu(replyToken, userId),
      "財富": () => sendWealthMenu(replyToken, userId),
      "健康": () => sendHealthMenu(replyToken, userId),
      "清除記錄": () => {
        if (userId === CONFIG.adminId) {
          clearSheet();
          return replyText(replyToken, "✅ 試算表 記錄 已清除!", userId);
        } else {
          return replyText(replyToken, "❌ 僅限管理員操作。", userId);
        }
      },
      "手動激勵": () => {
        if (userId === CONFIG.adminId) {
          manualEncourage(replyToken, userId);
        } else {
          replyText(replyToken, "❌ 僅限管理員操作。", userId);
        }
      }
    };
    if (presetMenus[msg]) {
      presetMenus[msg]();
      logReply(event, msg, "已執行預設選單");
      return textOutput("OK");
    }
    const items = msg.split(/[\s。,.]+/).filter(Boolean);
    if (items.length % 2 !== 0) return handleAiReply(replyToken, msg, event);
    return handleCalculation(items, replyToken, userId, msg, event);
  } catch (err) {
    console.error("handlePostEvent error:", err);
    return textOutput("error");
  }
}

function handleCalculation(items, replyToken, userId, userMessage, event) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const data = sheet.getDataRange().getValues();
  const map = {};
  data.slice(1).forEach(row => {
    map[row[0].toString().trim().toLowerCase()] = {
      displayName: row[0],
      pv: parseFloat(row[2]) || 0,
      price: parseFloat(row[3]) || 0
    };
  });
  let reply = "";
  let total = 0;
  let valid = false;
  for (let i = 0; i < items.length; i += 2) {
    const name = items[i].toLowerCase();
    const qty = parseInt(items[i + 1]);
    const item = map[name];
    if (!item || isNaN(qty) || qty <= 0) continue;
    valid = true;
    const amount = item.price * qty;
    total += amount;
    reply += `品項: ${item.displayName}、數量: ${qty}\n金額: ${amount.toFixed(0)}\n\n`;
  }
  if (!valid) return handleAiReply(replyToken, userMessage, event);
  reply += `總金額: ${total.toFixed(0)}\n`;
  replyText(replyToken, reply, userId);
  logReply(event, userMessage, reply);
  return textOutput("OK");
}

// === AI 回覆 ===
function handleAiReply(replyToken, msg, event) {
  const clean = msg.replace(/[\s\n\r\t\u3000.,!?！？。、()「」【】{}<>《》—…⋯💬😅😂👍❤️💖✍️✨🌟🔥🎉🥰🤔😢😭🙌👀🐣🐥🌸🎈🎁💯💡✅❌]+/g, '');
  if (!clean) return replyText(replyToken, "可以再多說一點嗎？😊", event.source.userId);
  const prompt = `請用不超過25字，簡短且溫暖地回應以下訊息:\"${msg}\"。強調你是分享財富、健康與美麗的人，讓對方感受到真誠與關懷。**請勿使用任何 Emoji 或表情符號。**`;
  try {
    const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + CONFIG.openAiApiKey
      },
      payload: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "你是\"彥彬\"一位分享財富、健康與美麗的專業分享顧問。回答必須有畫面感,增加敘事性、1有吸引力、2引思考、3有結論，溫暖且正能量、請用同理心、口語且真誠的語氣簡短回覆訊息，讓對方感受到被理解與關懷，適合用於每日分享。避免提及你是 AI 或機器人。**請勿使用任何 Emoji 或表情符號。**"
          },
          { role: "user", content: prompt }
        ]
      })
    });
    const aiReply = JSON.parse(response.getContentText()).choices[0].message.content.trim();
    Utilities.sleep(15000); // 模擬人性延遲
    pushTextMessage(event.source.userId, aiReply);
    logReply(event, msg, aiReply);
    return textOutput("OK");
  } catch (err) {
    console.error("handleAiReply error:", err);
    logReply(event, msg, "OpenAI API 回應錯誤：" + err.message);
    replyText(replyToken, "抱歉，目前無法處理您的請求，請稍後再試。", event.source.userId);
    return textOutput("error");
  }
}

// === 小工具 ===
function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function textOutput(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

function logEvent(event) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const profile = getUserProfile(event.source.userId);
  sheet.appendRow([new Date(), profile.userId, profile.displayName, event.message.text, "用戶訊息"]);
  
  // 記錄到Sheet3
  logToSheet3(profile.userId, profile.displayName, new Date());
}

function logReply(event, msg, reply) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const profile = getUserProfile(event.source.userId);
  sheet.appendRow([new Date(), profile.userId, profile.displayName, msg, reply]);
}

function getUserProfile(userId) {
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/profile/" + userId, {
      headers: { Authorization: "Bearer " + CONFIG.accessToken }
    });
    const profile = JSON.parse(res.getContentText());
    return { userId, displayName: profile.displayName || "unknown" };
  } catch (err) {
    return { userId, displayName: "unknown" };
  }
}

function replyText(token, text, userId) {
  const payload = {
    replyToken: token,
    messages: [{ type: "text", text, quickReply: getQuickReply(userId) }]
  };
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.accessToken
    },
    payload: JSON.stringify(payload)
  });
}

// === 自訂選單 & 快速回覆 ===
function clearSheet() {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
}

function getQuickReply(userId) {
  const items = [
    {
      type: "action",
      action: {
        type: "uri",
        label: "🔗 預約看得見",
        uri: "https://liff.line.me/2007475335-Z0LKm1wQ?v=1"
      }
    },
    {
      type: "action",
      action: {
        type: "message",
        label: "💰 財富",
        text: "財富"
      }
    },
    {
      type: "action",
      action: {
        type: "message",
        label: "🌿 健康",
        text: "健康"
      }
    }
  ];
  if (userId === CONFIG.adminId) {
    items.push({
      type: "action",
      action: {
        type: "message",
        label: "🧹 清除記錄",
        text: "清除記錄"
      }
    });
    items.push({
      type: "action",
      action: {
        type: "message",
        label: "📢 手動激勵",
        text: "手動激勵"
      }
    });
  }
  return { items };
}

// === 新增：每日定時發文 ===
function scheduledDailyPost() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  
  // 檢查是否在推播時間範圍內
  const isLunchTime = hour >= 12 && hour < 13;
  const isEveningTime = hour >= 17 && hour < 18;
  
  if (!isLunchTime && !isEveningTime) return;
  
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 近365天用戶
  const data = sheet.getDataRange().getValues();
  const activeUsers = {};
  
  for (let i = 1; i < data.length; i++) {
    const time = new Date(data[i][0]);
    if (time < cutoff) continue;
    const userId = data[i][1];
    const msg = (data[i][3] || "").toLowerCase();
    if (!activeUsers[userId]) {
      activeUsers[userId] = { userId, messages: [] };
    }
    activeUsers[userId].messages.push(msg);
  }
  
  for (const userId in activeUsers) {
    const messages = activeUsers[userId].messages.join(" ");
    let topic = "健康"; // 預設主題
    if (messages.includes("財富")) {
      topic = "財富";
    } else if (messages.includes("健康")) {
      topic = "健康";
    } else {
      topic = Math.random() < 0.5 ? "健康" : "財富";
    }
    const prompt = `請幫我產生一段不超過60字的${topic}主題短文，回答必須有畫面感,增加敘事性、1有吸引力、2引思考、3有結論，溫暖且正能量、請用同理心、口語且真�的語氣簡短回覆訊息，讓對方感受到被理解與關懷，適合用於每日分享。避免提及你是 AI 或機器人。**請勿使用任何 Emoji 或表情符號。**`;
    const aiReply = callOpenAiApi(prompt);
    if (aiReply) {
      // 記錄自動推播記錄
      const logSheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
      const profile = getUserProfile(userId);
      logSheet.appendRow([
        new Date(),
        userId,
        profile.displayName,
        `自動推播：${aiReply}`,
        "系統推播"
      ]);
      
      pushTextMessage(userId, aiReply);
      Logger.log(`已自動推播用戶 ${userId} - 主題：${topic}`);
    }
  }
}

// 呼叫 OpenAI API
function callOpenAiApi(prompt) {
  try {
    const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + CONFIG.openAiApiKey
      },
      payload: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "你是\"彥彬\"一位分享財富、健康與美麗的專業分享顧問。回答必須有畫面感,增加敘事性、1有吸引力、2引思考、3有結論，溫暖且正能量、請用同理心、口語且真誠的語氣簡短回覆訊息，讓對方感受到被理解與關懷，適合用於每日分享。避免提及你是 AI 或機器人。**請勿使用任何 Emoji 或表情符號。**"
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });
    const result = JSON.parse(response.getContentText());
    return result.choices[0].message.content.trim();
  } catch (err) {
    console.error("callOpenAiApi error:", err);
    return null;
  }
}

// 推播文字訊息
function pushTextMessage(userId, text) {
  const payload = {
    to: userId,
    messages: [{
      type: "text",
      text,
      quickReply: getQuickReply(userId)
    }]
  };
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.accessToken
    },
    payload: JSON.stringify(payload)
  });
}

// 手動激勵
// === 新增：手動激勵記錄 ===
function manualEncourage(replyToken, userId) {
  const prompt = `請幫我產生一段不超過60字的激勵短文，回答必須有畫面感，增加敘事性，1有吸引力、2引思考、3有結論，溫暖且正能量，請用同理心、口語且真誠的語氣簡短回覆訊息，讓對方感受到被理解與關懷，適合用於每日分享。避免提及你是 AI 或機器人。請勿使用任何 Emoji 或表情符號。`;
  const aiReply = callOpenAiApi(prompt);
  if (aiReply) {
    const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
    const timestamp = new Date();
    const profile = getUserProfile(userId);
    sheet.appendRow([
      timestamp,
      userId,
      profile.displayName,
      `手動激勵：${aiReply}`,
      "系統推播"
    ]);
    pushTextMessage(userId, aiReply);
    Logger.log(`✅ 已手動激勵用戶 ${userId} - 內容：${aiReply}`);
  } else {
    replyText(replyToken, "抱歉，目前無法產生激勵短文，請稍後再試。", userId);
    Logger.log(`⚠️ 手動激勵失敗：無法取得 AI 回覆`);
  }
}

function scheduledDailyPost() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  
  // 檢查是否在推播時間範圍內
  const isLunchTime = hour >= 12 && hour < 13;
  const isEveningTime = hour >= 17 && hour < 18;
  
  if (!isLunchTime && !isEveningTime) return;
  
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 近365天用戶
  const data = sheet.getDataRange().getValues();
  const activeUsers = {};
  
  for (let i = 1; i < data.length; i++) {
    const time = new Date(data[i][0]);
    if (time < cutoff) continue;
    const userId = data[i][1];
    const msg = (data[i][3] || "").toLowerCase();
    if (!activeUsers[userId]) {
      activeUsers[userId] = { userId, messages: [] };
    }
    activeUsers[userId].messages.push(msg);
  }
  
  // 在這裡加入推播記錄的邏輯
}

function scheduledDailyPost() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  
  // 檢查是否在推播時間範圍內
  const isLunchTime = hour >= 12 && hour < 13;
  const isEveningTime = hour >= 17 && hour < 18;
  
  if (!isLunchTime && !isEveningTime) return;
  
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 近365天用戶
  const data = sheet.getDataRange().getValues();
  const activeUsers = {};
  
  for (let i = 1; i < data.length; i++) {
    const time = new Date(data[i][0]);
    if (time < cutoff) continue;
    const userId = data[i][1];
    const msg = (data[i][3] || "").toLowerCase();
    if (!activeUsers[userId]) {
      activeUsers[userId] = { userId, messages: [] };
    }
    activeUsers[userId].messages.push(msg);
  }
  
  for (const userId in activeUsers) {
    const messages = activeUsers[userId].messages.join(" ");
    let topic = "健康"; // 預設主題
    if (messages.includes("財富")) {
      topic = "財富";
    } else if (messages.includes("健康")) {
      topic = "健康";
    } else {
      topic = Math.random() < 0.5 ? "健康" : "財富";
    }
    const prompt = `請幫我產生一段不超過60字的${topic}主題短文，回答必須有畫面感,增加敘事性、1有吸引力、2引思考、3有結論，溫暖且正能量、請用同理心、口語且真誠的語氣簡短回覆訊息，讓對方感受到被理解與關懷，適合用於每日分享。避免提及你是 AI 或機器人。**請勿使用任何 Emoji 或表情符號。**`;
    const aiReply = callOpenAiApi(prompt);
    if (aiReply) {
      // 記錄自動推播記錄
      const logSheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
      const profile = getUserProfile(userId);
      logSheet.appendRow([
        new Date(),
        userId,
        profile.displayName,
        `自動推播：${aiReply}`,
        "系統推播"
      ]);
      
      pushTextMessage(userId, aiReply);
      Logger.log(`已自動推播用戶 ${userId} - 主題：${topic}`);
    }
  }
}

// === 修改：logEvent 記錄格式 ===
function logEvent(event) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const profile = getUserProfile(event.source.userId);
  sheet.appendRow([
    new Date(),
    profile.userId,
    profile.displayName,
    event.message.text,
    "用戶訊息"
  ]);
}

// 獲取群組成員
function getGroupMembers(groupId) {
  const url = `https://api.line.me/v2/bot/group/${groupId}/members`;
  const options = {
    method: "get",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.accessToken
    }
  };
  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());
  return result;
}

// 推播給所有好友
function pushToAllFriends() {
  // 獲取好友的群組ID
  const groupIds = getGroupMembers(CONFIG.adminId).members.map(member => member.userId);
  // 推播消息給每個好友
  for (const userId of groupIds) {
    const prompt = `請幫我產生一段不超過60字的激勵短文，回答必須有畫面感,增加敘事性、1有吸引力、2引思考、3有結論，溫暖且正能量、請用同理心、口語且真誠的語氣簡短回覆訊息，讓對方感受到被理解與關懷，適合用於每日分享。避免提及你是 AI 或機器人。**請勿使用任何 Emoji 或表情符號。**`;
    const aiReply = callOpenAiApi(prompt);
    if (aiReply) {
      pushTextMessage(userId, aiReply);
      Logger.log(`已推播用戶 ${userId} 激勵文`);
    }
  }
}

function logToSheet3(userId, displayName, date) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet3");
  const data = sheet.getDataRange().getValues();
  
  // 檢查是否已存在相同用戶ID的記錄
  const existingRows = data.filter(row => row[0] === userId);
  
  if (existingRows.length === 0) {
    // 如果不存在，則新增記錄
    sheet.appendRow([userId, displayName, date]);
  } else {
    // 如果已存在，則更新日期
    const rowIndex = data.findIndex(row => row[0] === userId);
    sheet.getRange(rowIndex + 1, 3).setValue(date); // 假設日期在第三列
  }
}

function logEvent(event) {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName("Sheet1");
  const profile = getUserProfile(event.source.userId);
  sheet.appendRow([new Date(), profile.userId, profile.displayName, event.message.text]);
  
  // 記錄到Sheet3
  logToSheet3(profile.userId, profile.displayName, new Date());
}

// === 以下是整合的第二段程式碼 ===
function sendCarouselMenu(replyToken, userId) {
  const messages = [
    {
      type: "template",
      altText: "🔗 看得見",
      template: {
        type: "carousel",
        columns: [
          {
            thumbnailImageUrl: 'https://yb131419.github.io/asset/asset07_1.jpg?v=1',
            title: '一滴覺醒',
            text: '九天細胞再生、三個月逆齡10歲\n保證滿意、無效退款',
            actions: [
              { type: 'uri', label: '🔗 一滴覺醒', uri: 'https://liff.line.me/2007475335-jBeZYBxo?v=1' }
            ]
          }
        ]
      },
      quickReply: getQuickReply(userId)
    }
  ];
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.accessToken,
    },
    payload: JSON.stringify({ replyToken, messages })
  });
}

function sendWealthMenu(replyToken, userId) {
  const messages = [
    {
      type: "template",
      altText: "💰 財富方案",
      template: {
        type: "carousel",
        columns: [
          {
            thumbnailImageUrl: 'https://yb131419.github.io/asset/asset07_1.jpg?v=1',
            title: '一滴覺醒',
            text: '九天細胞再生、三個月逆齡10歲\n保證滿意、無效退款',
            actions: [
              { type: 'uri', label: '🔗 一滴覺醒', uri: 'https://liff.line.me/2007475335-jBeZYBxo?v=1' }
            ]
          }
         //  {
         //    thumbnailImageUrl: 'https://yb131419.github.io/asset/asset08_1.jpg?v=1',
         //    title: '逆轉青春',
         //    text: '最好的養生是早睡早起\n不動刀的美麗誰不動心',
         //    actions: [
         //      { type: 'uri', label: '🔗 逆轉青春', uri: 'https://liff.line.me/2007475335-KLXmQe7x?v=1' }
         //    ]
         //  }
        ]
      },
      quickReply: getQuickReply(userId)
    }
  ];
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.accessToken,
    },
    payload: JSON.stringify({ replyToken, messages })
  });
}

function sendHealthMenu(replyToken, userId) {
  const messages = [
    {
      type: "template",
      altText: "🌿 健康方案",
      template: {
        type: "carousel",
        columns: [
          {
            thumbnailImageUrl: 'https://yb131419.github.io/asset/asset02.jpg?v=4',
            title: '🌿 癌症',
            text: '\n每天每時痛到像拿針在戳\n比生孩子還痛你能想象嗎', 
            actions: [
              { type: 'uri', label: '🔗 三癌末', uri: 'https://liff.line.me/2007475335-RVyOa6yg?v=1' },
              { type: 'uri', label: '🔗 全癌末', uri: 'https://liff.line.me/2007475335-5BKMwjlO?v=1' }
            ]
          },
          {
            thumbnailImageUrl: 'https://yb131419.github.io/asset/asset03_1.jpg?v=1',
            title: '🌿 洗腎、癲癇',
            text: '\n世界上最好聲音、是尿尿聲\n癲癇咬舌被狂打、就是要救活',
            actions: [
              { type: 'uri', label: '🔗 洗腎二年', uri: 'https://liff.line.me/2007475335-b5wzA1qJ?v=1' },
              { type: 'uri', label: '🔗 癲癇十六年', uri: 'https://liff.line.me/2007475335-B3Pr98Wd?v=1' }
            ]
          },
          {
            thumbnailImageUrl: 'https://yb131419.github.io/asset/asset05_1.jpg?v=1',
            title: '🌿 中風、帕金森',
            text: '\n中風二十四年、走路掉七根拐杖\n教書三十五年、退休卻包尿布',
            actions: [
              { type: 'uri', label: '🔗 中風二十四年', uri: 'https://liff.line.me/2007475335-jN9DOxo3?v=1' },
              { type: 'uri', label: '🔗 帕金森包尿布', uri: 'https://liff.line.me/2007475335-anYWwZG4?v=1' }
            ]
          }
        ]
      },
      quickReply: getQuickReply(userId)
    }
  ];
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.accessToken
    },
    payload: JSON.stringify({ replyToken, messages })
  });
}
