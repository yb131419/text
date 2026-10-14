# 小乖 × LINE 官方帳號 設定教學

完成後你可以：

- 在 LINE 上直接跟小乖聊天，叫它幫你記待辦、排行程、設提醒、寫筆記
- 提醒時間到，小乖會用 LINE 通知你（每 5 分鐘檢查一次）
- LINE 和網頁版（Assistant.html）看到的是同一份資料，資料存在你自己的 Google 試算表

整個流程大約 15 分鐘，只需要做一次。

## 1. 建立 LINE 官方帳號與 Messaging API

1. 到 [LINE Developers](https://developers.line.biz/console/) 用你的 LINE 帳號登入。
2. 建立 Provider（名字隨意，例如「彥彬」）。
3. 在 Provider 下建立 **Messaging API** 頻道，這一步會同時建立小乖專屬的新 LINE 官方帳號（名稱可以取「小乖」）。請不要用店裡（莫凡）的官方帳號，避免客人的訊息跑進小乖。
4. 進入頻道的「Messaging API」分頁，最下方的 **Channel access token** 按「Issue」，複製起來備用。
5. 到 LINE Official Account Manager 的「回應設定」：
   - 關閉「自動回應訊息」
   - 開啟「Webhook」

## 2. 建立 Google 試算表與 Apps Script

1. 到 Google 試算表新建一份空白試算表，命名為「小乖資料庫」。
2. 選單「擴充功能 → Apps Script」。
3. 把編輯器裡的 `Code.gs` 內容全部刪掉，貼上本資料夾的 [Code.gs](Code.gs)，按儲存。
4. 左側齒輪「專案設定」：
   - 勾選「在編輯器中顯示 appsscript.json」，回到編輯器，把 `appsscript.json` 換成本資料夾的 [appsscript.json](appsscript.json)（主要是把時區設成台北）。
   - 往下找到「指令碼屬性」，新增兩個：

     | 屬性 | 值 |
     | --- | --- |
     | `LINE_CHANNEL_ACCESS_TOKEN` | 第 1 步複製的 Channel access token |
     | `OPENAI_API_KEY` | 你的 OpenAI 金鑰（`sk-` 開頭） |

5. 回到編輯器，上方函式選單選 `setup`，按「執行」。第一次會要求授權，依畫面允許即可。
6. 執行完看「執行記錄」，會出現 **同步密碼**，抄下來。試算表裡也會多出「待辦、行程、提醒、筆記…」幾個分頁。

## 3. 部署成網頁應用程式

1. 右上角「部署 → 新增部署作業」，類型選「網頁應用程式」。
2. 執行身分：**我**；誰可以存取：**所有人**。
3. 按「部署」，複製「網頁應用程式網址」（`https://script.google.com/macros/s/…/exec`）。

之後如果改了程式，要用「部署 → 管理部署作業 → 編輯 → 版本選新版本」更新，網址才不會變。

## 4. 接上 LINE

1. 回到 LINE Developers 的「Messaging API」分頁，Webhook URL 填：

   ```
   https://script.google.com/macros/s/…/exec?key=你的同步密碼
   ```

2. 開啟「Use webhook」。
3. 用手機掃頁面上的 QR code 加小乖好友，傳：

   ```
   綁定 你的同步密碼
   ```

   看到「綁定完成」就可以開始聊天了。綁定後只有你能使用，別人加好友也不會回應。

> 按 Webhook 旁的「Verify」可能會顯示失敗，這是因為 Apps Script 會先轉址一次。只要實際傳訊息小乖有回，就是正常的。

## 5. 接上網頁版

打開 Assistant.html → 設定 → 「LINE 與雲端同步」，貼上第 3 步的網址和同步密碼，按「儲存並立即同步」。看到「上次同步：…」就完成了。

網頁開著時每分鐘自動同步一次，切回分頁、新增或修改資料時也會同步。換手機或換瀏覽器，只要填同樣的網址和密碼，資料就會跟過來。

## 常見問題

**LINE 上可以做什麼？** 傳「說明」看範例。傳「清除對話」會讓小乖忘掉 LINE 上的聊天內容，待辦和筆記不受影響。目前只看得懂文字訊息。

**要換 AI 模型？** 在指令碼屬性新增 `MODEL`，值填 `gpt-5-mini`（預設是 `gpt-4o-mini`）。

**費用？** Google 試算表與 Apps Script 免費。OpenAI 依用量計費。LINE 一般回覆訊息不計費，但提醒用的是「推播訊息」，免費方案每月有則數上限，同一時間到的提醒會合併成一則送出。

**網頁和 LINE 都會提醒嗎？** 網頁開著時，網頁也會跳提醒，所以有機會收到兩次，屬正常現象。

**資料可以直接在試算表改嗎？** 請不要手動改「資料」那一欄，那是程式讀的內容；「摘要」欄只是方便你瀏覽。要改資料請用網頁或 LINE。

**安全性：** 同步密碼等於鑰匙，不要分享給別人。若外流，到指令碼屬性改掉 `SYNC_KEY`，再同步更新 LINE 的 Webhook URL 和網頁設定；若要換綁 LINE 帳號，刪掉 `OWNER_USER_ID` 後重新傳「綁定」。
