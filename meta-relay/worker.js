// 小乖留言回覆的 Cloudflare 中繼站
// Meta 的 Webhook 要「原樣回 hub.challenge」、也不接受轉址，Apps Script 做不到，所以先到這裡：
//   GET  驗證：verify_token 對了就原樣回 challenge
//   POST 通知：（有設 APP_SECRET 就先驗簽章）馬上回 200 給 Meta，再把內容加上 relay 通關密碼轉給小乖的 Apps Script
// 要在 Cloudflare 設定的變數：APPS_URL、RELAY_KEY、VERIFY_TOKEN（傳「留言設定」給小乖就會看到），APP_SECRET（Meta 應用程式密鑰，建議設）
// TikTok 圖卡（傳「TK圖卡」給小乖看步驟）：TikTok 只從驗證過的網址抓圖，所以圖卡經過這裡轉
//   GET /tiktok….txt  回 TK_VERIFY（TikTok「URL prefix」驗證檔裡的那一行）
//   GET /img/<雲端硬碟檔案 id>  轉發小乖發文暫存的圖片（只轉圖片）
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (req.method === 'GET') {
      if (u.searchParams.get('hub.mode') === 'subscribe') {
        if (u.searchParams.get('hub.verify_token') !== env.VERIFY_TOKEN) return new Response('verify token 不對', { status: 403 });
        return new Response(u.searchParams.get('hub.challenge') || '');
      }
      if (/^\/tiktok[\w-]*\.txt$/.test(u.pathname) && env.TK_VERIFY) return new Response(env.TK_VERIFY, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const img = u.pathname.match(/^\/img\/([\w-]{20,})$/);
      if (img) {
        const r = await fetch('https://lh3.googleusercontent.com/d/' + img[1]);
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !/^image\//.test(type)) return new Response('not found', { status: 404 });
        return new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
      }
      return new Response('小乖中繼站運作中');
    }
    if (req.method !== 'POST') return new Response('', { status: 405 });
    const raw = await req.text();
    if (env.APP_SECRET && !(await sigOk(raw, req.headers.get('x-hub-signature-256') || '', env.APP_SECRET)))
      return new Response('簽章不對', { status: 401 });
    let body;
    try { body = JSON.parse(raw); } catch (e) { return new Response('ok'); }
    body.relay = env.RELAY_KEY;
    ctx.waitUntil(fetch(env.APPS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    return new Response('ok');
  },
};

async function sigOk(raw, header, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  const want = 'sha256=' + hex;
  if (header.length !== want.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return d === 0;
}
