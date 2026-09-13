# Beg Board

一個「誰最會跪求 Codex reset」的即時排行榜。靈感來自 <https://codex-resets.com/> 的 beg 按鈕，
但把匿名的全域計數器換成**具名競賽**：用 Threads 登入、每個人的點擊次數分開算、即時排行榜、
每天自動把總榜截圖發到 X 並 @thsottiaux。

**Demo**：`web/` 直接開就能玩（demo 模式，資料只在瀏覽器裡，不連任何後端）。

```bash
npm run serve      # http://localhost:4173
```

## 這跟原網站差在哪

| | codex-resets.com | Beg Board |
|---|---|---|
| 身分 | 匿名 | Threads OAuth（只讀 handle + 頭像） |
| 計數 | 單一全域數字 | 每人一筆 + 全域總計 |
| 即時 | WebSocket 廣播國旗 emoji | WebSocket 廣播**頭像**＋即時名次變動 |
| 排行 | 無 | 前三名 podium + 即時 FLIP 換位動畫 |
| 動畫 | 按鈕彈跳、數字滾動、國旗飛出 | 上述全部 ＋ 連擊階級（🙏→✨→🔥→👑）、超車 toast |
| 對外 | 無 | 每日自動截圖發 X |

## 語言

**繁中（港澳台）／簡中／英文，自動判斷。** 判斷順序（先命中者勝）：

1. 使用者自己按過右上角的語言鈕（存 `localStorage`）
2. 網址 `?lang=zh-Hant` / `?lang=zh-Hans` / `?lang=en`
3. `navigator.languages` —— **第一個中文標籤決定字體**：
   `zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO` → 繁中，其餘中文標籤（`zh`、`zh-CN`、
   `zh-Hans`、`zh-SG`）→ 簡中。把 `zh-CN` 排在 `zh-TW` 前面的人會拿到簡中，
   這是尊重他自己的排序。
4. Worker 從 edge 回報的 `viewer_country`：`TW` / `HK` / `MO` → 繁中，`CN` → 簡中

第 3 步是同步的，所以**第一次繪製就已經是對的語言**，不會先閃一下英文。
第 4 步只在前三步都沒表態時才生效，且只看國碼。

新加坡與馬來西亞**不在 geo 清單裡** —— 那兩地是多語社會，在那裡用英文瀏覽器的人
多半就是要英文；當地的中文使用者第 3 步就已經接住了。

語言鈕是循環的：`繁 → 简 → EN → 繁`，顯示的是**目前**的語言。

字體：Fredoka 沒有中文字，瀏覽器會逐字 fallback。CSS 的 `--font-cjk` 依 `html[lang]`
切換 Noto Sans TC / SC，而 `i18n.js` **只載入當下語言需要的那一套** ——
英文使用者兩套都不會下載。

每日發到 X 的那張卡（`board.html`）維持英文 —— 它的讀者是全球 X 使用者。

## 架構

```
web/          純靜態，零 build step（含 i18n）→ GitHub Pages
worker/       Cloudflare Worker + Durable Object → OAuth 交換、計數、WebSocket
scripts/      Playwright 截圖 + X API v2 發文
.github/      Pages 部署 + 每日排程
```

**為什麼不是純 GitHub Pages**：見 [docs/DEPLOY.md](docs/DEPLOY.md) 的第一節。
簡短版 —— 前端可以，其餘三件事（OAuth 的 `client_secret` 交換、共享狀態、每日排程）
靜態託管做不到，需要一個 Worker。Worker 那份在免費額度內。

## 快速開始

1. `npm run serve`，開 <http://localhost:4173>，按 **Sign in with Threads** 進 demo 模式試玩。
2. 要上線：照 [docs/DEPLOY.md](docs/DEPLOY.md) 走（Threads App → Worker → Pages → X 排程）。

## 已知邊界

- **點擊速率上限 8/秒/帳號**（Durable Object 裡的 token bucket）。沒有這條，排行榜量的是
  autoclicker 的品質而不是誠意。超過的點擊 UI 照樣有反應，但不計分。
- **Threads access token 不留存**。換到 token 只為了讀 `id` / `username` / 頭像，讀完就丟，
  之後靠自簽的 session token（HMAC-SHA256，30 天）認人。
- **每日發文是 @ 真人**。頻率請維持一天一次；要停就把 `.github/workflows/daily-x-post.yml`
  的 `schedule` 拿掉。
- 與 OpenAI、Threads、codex-resets.com 均無關聯。
