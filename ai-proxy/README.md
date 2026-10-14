# 小乖 AI 代理（把 OpenAI 金鑰放到後台）

Work.html（AI 集團）、trade.html（交易助手）、Assistant.html（小乖）不再把 OpenAI 金鑰存在瀏覽器，
而是把請求送到你自己的 Google Apps Script，由 Apps Script 帶著金鑰去呼叫 OpenAI。
網頁上只需要填「代理網址」和「通行碼」，三個頁面共用同一組設定，填一次就好。

代理另外幫你把關：

- 只允許 `gpt-4o-mini`、`gpt-4o`、`gpt-5-mini` 三種模型
- 單次回覆最多 4000 token
- 每天最多 500 次呼叫（台灣時間換日歸零）

## 方法 A：已經架好 line-bot（建議）

不用另外部署，直接加進同一個 Apps Script 專案。

1. 打開 line-bot 那份試算表 →「擴充功能 → Apps Script」。
2. 左邊「檔案」旁按「＋ → 指令碼」，命名為 `AiProxy`，貼上本資料夾的 `AiProxy.gs` 全部內容。
3. 打開 `Code.gs`，在 `doPost` 裡「網頁同步」那段的上面加一行：
   ```js
   if (body.action === 'openai') return handleAiProxy_(body);
   ```
4. 右上角「部署 → 管理部署作業」→ 編輯（鉛筆）→ 版本選「新版本」→ 部署。網址不會變。
5. 到網頁的設定頁填：
   - 代理網址：line-bot 的網頁應用程式網址（結尾是 `/exec`）
   - 通行碼：line-bot 的同步密碼（指令碼屬性 `SYNC_KEY`）

`OPENAI_API_KEY` line-bot 已經設定過，不用重填。

## 方法 B：沒有 line-bot，單獨架一個

1. 到 https://script.google.com 建立新專案。
2. 把 `AiProxy.gs` 和 `Standalone.gs` 各新增成一個指令碼檔案貼上。
3. 「專案設定（齒輪）→ 指令碼屬性」新增：
   - `OPENAI_API_KEY`：你的 OpenAI 金鑰
   - `AI_PASSCODE`：自己訂一組通行碼（建議 12 碼以上的亂數）
4. 「部署 → 新增部署作業」→ 類型選「網頁應用程式」，執行身分「我」，存取權「所有人」→ 部署，第一次要按「授權存取」。
5. 把拿到的 `/exec` 網址和通行碼填到網頁的設定頁。

## 換完之後

- 網頁打開後會自動清掉以前存在瀏覽器裡的 OpenAI 金鑰。
- 那把舊金鑰曾經存在瀏覽器，建議到 https://platform.openai.com/api-keys 作廢它，產生新的一把，只放進 Apps Script 的 `OPENAI_API_KEY`。
- 通行碼外洩時，到指令碼屬性改掉 `SYNC_KEY` 或 `AI_PASSCODE` 即可，不用動 OpenAI 金鑰。
  （改 `SYNC_KEY` 也要同步更新 LINE／Telegram 的 Webhook 網址，所以單純想換通行碼時，用 `AI_PASSCODE` 比較省事。）
