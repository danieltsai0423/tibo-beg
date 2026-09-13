# 部署指南

## 0. 先回答：能不能直接丟 GitHub Pages？

**前端可以，整套不行。** GitHub Pages 只會回傳靜態檔案 —— 沒有伺服器端執行、沒有共享儲存、
沒有排程器。這個網站的四個需求裡，它只滿足得了一個：

| 需求 | GitHub Pages 單獨做得到嗎 | 為什麼 |
|---|---|---|
| 顯示頁面、動畫、UI | ✅ | 純 HTML/CSS/JS，零 build step |
| Threads 登入 | ❌ | Threads 用 OAuth 2.0 **authorization code** flow，拿 code 換 token 時必須帶 `client_secret`。Threads 目前不支援公開 client 的 PKCE-only 流程 —— 把 secret 放進靜態 JS 等於公開它，任何人都能冒用你的 app 身分 |
| 跨使用者的計數與排行榜 | ❌ | 需要一份所有人共寫的持久狀態。靜態站只有每個瀏覽器各自的 `localStorage`，互相看不到 |
| 即時更新 | ❌ | 需要 WebSocket 或 SSE 伺服器 |
| 每日截圖發 X | ⚠️ | 頁面本身不行，但**同一個 repo 的 GitHub Actions 可以** —— Actions 有 cron、有 secrets、跑得動 Playwright。這條不需要另外的伺服器 |

**結論**：`web/` 放 GitHub Pages（免費、CDN、自動 HTTPS），把那三件做不到的事交給一個
Cloudflare Worker + Durable Object。Worker 同時解掉 OAuth、共享計數、WebSocket 三件事，
而且在免費方案內（Durable Objects 的 SQLite backend 已開放免費方案，`wrangler.toml` 裡的
`new_sqlite_classes` 就是為此）。

選 Cloudflare 而不是別家的理由：
- 它同時提供 OAuth 需要的伺服器、realtime 需要的 WebSocket、計數需要的單寫者狀態。
  換成 Supabase 要自己補 Edge Function 做 token 交換；換成 Vercel 要另外找 realtime。
- `request.cf.country` 直接給國別，不用再呼叫 geo API（原網站的國旗就是這樣來的）。
- codex-resets.com 本身也跑在 Cloudflare 上，算是同一條路被驗證過。

---

## 1. Threads App

1. <https://developers.facebook.com/apps> → 建立 app → 加入 **Threads API** 產品。
2. Valid OAuth Redirect URI 填 Worker 的 callback：
   `https://<worker>.workers.dev/api/auth/threads/callback`
3. 記下 **Threads App ID** 與 **Threads App Secret**。
4. 上線前 app 處於開發模式，只有被加進去的測試帳號能登入；要公開需要送審 `threads_basic`。

> 本專案只要 `threads_basic`。不會發文、不會讀你的貼文。

## 2. Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
```

編輯 `wrangler.toml`：把 `ALLOWED_ORIGINS` / `APP_URL` 換成你的 Pages 網址
（例如 `https://danieltsai0423.github.io`，**不要結尾斜線**；本機開發可保留 `http://localhost:4173`）。

```bash
npx wrangler secret put THREADS_APP_ID
npx wrangler secret put THREADS_APP_SECRET
npx wrangler secret put SESSION_SECRET      # 隨機 48 bytes，例如 openssl rand -base64 48
npx wrangler deploy
```

部署完會給你 `https://tibo-beg-api.<你的子網域>.workers.dev`。

**驗一下**：

```bash
curl https://tibo-beg-api.<子網域>.workers.dev/api/leaderboard
```

應該回 `{"total":0,"bps":0,"beggars":0,"board":[],...}`。

## 3. GitHub Pages

推上 GitHub 後，Settings → Pages → Source 選 **GitHub Actions**。

然後 Settings → Secrets and variables → Actions → **Variables**：

| 名稱 | 值 |
|---|---|
| `API_BASE` | `https://tibo-beg-api.<子網域>.workers.dev` |
| `BOARD_URL` | `https://<user>.github.io/<repo>/board.html` |
| `MENTION` | `@thsottiaux`（可省略，預設就是這個） |

`deploy-pages.yml` 會在部署時用 `API_BASE` 覆寫 `web/config.js`，所以 repo 裡那份可以維持空字串
（空字串＝demo 模式，本機打開就能玩）。

推一次 `main` 或手動跑 workflow 即可部署。

## 4. 每日發 X

### 費用（2026-09 查證，**這點變了**）

X 的免費層**已於 2026-02-06 取消**，改成 pay-per-use：發一則貼文 **$0.015**（含連結的 $0.20）。
沒有月低消，但**必須先在 <https://console.x.com> 儲值**才叫得動 API。
一天一則 ≈ **每月 $0.5 以內**。這是整個專案唯一的固定成本。

（如果不想花這筆錢：把截圖當成 Actions artifact 存起來手動發，workflow 已經會上傳
`board-card` artifact，把 `Post to X` 那步拿掉即可。）

### 設定

1. <https://console.x.com> 建 Project → App，儲值。
2. App 的 **User authentication settings** 打開，權限選 **Read and write**。
3. 產生 **API Key / Secret** 與 **Access Token / Secret**（產完 token 後若再改權限，token 要重新產）。
4. GitHub → Settings → Secrets and variables → Actions → **Secrets**：
   `X_API_KEY`、`X_API_SECRET`、`X_ACCESS_TOKEN`、`X_ACCESS_SECRET`。

### 先試跑

```bash
npm install
npx playwright install chromium
node scripts/shot.mjs --url http://localhost:4173/board.html --out out/board.png
node scripts/post-to-x.mjs --image out/board.png --dry-run
```

`--dry-run` 會印出貼文內容但**不會送出**。確認無誤後，在 GitHub Actions 手動跑
`Daily board post to X` 並把 `dry_run` 取消勾選，做一次真實測試。

排程是 `0 9 * * *`（UTC）＝ 台灣時間 17:00。GitHub 的 cron 是 best-effort，尖峰時可能晚幾十分鐘。

---

## 常見問題

**登入後跳回來帶 `#error=token_exchange_failed`**
`redirect_uri` 必須和 Threads app 設定裡的字串**完全一致**（含結尾斜線與 http/https）。
Worker 送出的是 `https://<worker>/api/auth/threads/callback`。

**登入後跳回來帶 `#error=bad_state`**
state 有 10 分鐘效期；或是 `ALLOWED_ORIGINS` 沒把你的 Pages 網址列進去，導致 redirect 被擋。

**排行榜不動、右上角顯示 offline**
Worker 沒部署、`API_BASE` 打錯，或 CORS 被擋。開 DevTools → Network 看 `/api/leaderboard`
的狀態碼；403/無 `access-control-allow-origin` 就是 `ALLOWED_ORIGINS` 沒對上。

**X 發文回 401**
OAuth 1.0a 簽章只簽 `oauth_*` 與 query string，**不簽 multipart / JSON body**。
若你改過 `post-to-x.mjs` 的簽章邏輯，先確認這點。其次是 access token 的權限不是 read-write。

**X 發文回 403 / 餘額不足**
Console 沒儲值，或該 app 不在有付費的 Project 底下。
