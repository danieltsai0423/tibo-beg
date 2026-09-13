# 部署指南

## 0. 先回答：能不能直接丟 GitHub Pages？

**前端可以，整套不行。** GitHub Pages 只會回傳靜態檔案 —— 沒有伺服器端執行、沒有共享儲存、
沒有排程器。這個網站的四個需求裡，它只滿足得了一個：

| 需求 | GitHub Pages 單獨做得到嗎 | 為什麼 |
|---|---|---|
| 顯示頁面、動畫、UI | ✅ | 純 HTML/CSS/JS，零 build step |
| Google 登入 | ❌ | OAuth 2.0 **authorization code** flow，拿 code 換 token 時必須帶 `client_secret`。把 secret 放進靜態 JS 等於公開它，任何人都能冒用你的 app 身分 |
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

## 1. Google OAuth client

1. <https://console.cloud.google.com/apis/credentials> → 建（或選）一個專案。
2. **OAuth consent screen**：User type 選 **External**，填 app 名稱與聯絡信箱。
   Scope **只加 `openid` 與 `.../auth/userinfo.profile`** —— 這兩個是
   non-sensitive scope，**不需要 Google 審核**就能直接 Publish 成 production。
   **不要加 `email`**：我們不需要，而多要一個不會顯示的個資只是負債。
3. **Credentials → Create credentials → OAuth client ID → Web application**。
4. Authorized redirect URI 填 Worker 的 callback，**字串完全一致**：
   ```
   https://tibo-beg-api.daniel0423.workers.dev/api/auth/google/callback
   ```
5. 拿到 **Client ID** 與 **Client secret**。
6. Consent screen 記得按 **Publish app** 切到 production；留在 Testing 模式的話
   只有你加進測試名單的帳號能登入（上限 100 人）。

> 只要 `openid profile`。拿到的是 `sub`（穩定的不透明 id）、`name`、`picture`，
> **沒有 email**。排行榜顯示的是 Google 的 `name`。

## 2. Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
```

編輯 `wrangler.toml`：把 `ALLOWED_ORIGINS` / `APP_URL` 換成你的 Pages 網址
（例如 `https://danieltsai0423.github.io`，**不要結尾斜線**；本機開發可保留 `http://localhost:4173`）。

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
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
| `MIN_BEGGARS` | 少於這個人數就跳過當天不發（可省略，預設 `3`） |
| `HASHTAGS` | 可省略，預設 `#Codex #OpenAI`。設成空字串就不加 |

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

### 貼文格式

全英文，四行，圖片附在貼文上：

```
128,430 begs for a Codex reset so far.
🥇 ratelimited 21,044 · 🥈 tokenburner 18,320 · 🥉 ctx_window 15,877
12 people begging, 2026-09-14. @thsottiaux — the people have spoken 🙏
#Codex #OpenAI
```

三個刻意的決定：

- **@提及放結尾，不放開頭。** 以 `@某人` 開頭的貼文會被當成回覆，只有同時追蹤
  雙方的人看得到 —— 那等於自廢觸及。
- **只放兩個 hashtag。** 2026-09 查證：1–2 個約 +21% 互動，3 個以上 −17%，
  5 個以上 −40%。腳本會強制上限為 2，超過會警告並截掉。
- **貼文內不放連結。** 含連結的貼文每則 **$0.20**（不含連結是 $0.015，13 倍），
  而且 X 會降低含連結貼文的觸及。網址改印在**圖片**的左下角，由 `board.html`
  依自己被服務的位置推導出來。

太長時會**從中間**捨棄（先丟前三名那行），@提及與 hashtag 永遠保留 ——
它們才是這則貼文的重點。

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
`redirect_uri` 必須和 Google Credentials 裡登記的字串**完全一致**（含結尾斜線與
http/https）。Worker 送出的是 `https://<worker>/api/auth/google/callback`。

**登入後跳回來帶 `#error=google_not_configured`**
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 還沒設。這是刻意的提示 ——
沒有這道防護的話會帶著 `client_id=undefined` 轉去 Google 的錯誤頁。

**Google 顯示「This app isn't verified」**
consent screen 還在 Testing，或 scope 裡混進了 sensitive scope。
只用 `openid` + `userinfo.profile` 的話 publish 到 production 不需要審核。

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
