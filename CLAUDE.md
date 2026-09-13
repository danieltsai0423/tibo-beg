# Beg Board — agent notes

Google 登入 + 即時 beg 排行榜。靈感來源是 <https://codex-resets.com/> 的 beg 按鈕。
部署與設定看 [docs/DEPLOY.md](docs/DEPLOY.md)，那裡也有「為什麼不能純 GitHub Pages」的完整理由。

## 邊界

- `web/` **不能有 build step**。它直接被 GitHub Pages 吐出去，加打包器等於自找麻煩。
  沒有框架、沒有 npm 相依，只有三個檔案 + `board.html`。
- `web/config.js` **只放公開值**。CI 會在部署時用 repo variable `API_BASE` 覆寫它。
- 秘密只存在兩個地方：Worker 的 `wrangler secret`，與 GitHub Actions secrets。
  絕不進 repo。
- Durable Object **只有一個實例**（`ROOM_NAME=global`）。全域排行榜需要單一寫者；
  要分 cycle（每次 Codex reset 重新計算）就換 `ROOM_NAME`，不要在同一個物件裡分桶。

## 容易踩的地方

- **OAuth 只要 `openid profile`，不要 `email`。** 這兩個是 non-sensitive scope，
  不需要 Google 審核即可 publish。一旦加了 sensitive scope 就要送審（數週），
  而我們根本不需要 email —— 公開排行榜上也絕不能顯示它。
- **`uid` 有 provider 前綴**（`google:<sub>`）。要加第二家登入時沿用這個慣例，
  不同平台的 id 直接當 key 會有撞號風險。
- **改名的驗證順序不能調換**：先正規化剝掉隱形字元，**再**做唯一性比對。
  反過來的話，`Rate​Limited` 會被當成跟 `RateLimited` 不同的名字而通過。
- **`/beg` 不可以覆寫 `dn`。** session token 裡的 `un` 是 provider 給的名字，
  每次跪求都會帶上來；使用者自選的 `dn` 是另一個欄位，只有 `/name` 能動它。
- **唯一性檢查放在 Durable Object 裡**，因為它要一次看到所有人的名字 ——
  而那正好是 DO 的記憶體內容，不需要額外索引。放進 router 就做不到了。

- **排序快取會讓 rank 變成 `null`。** `BegRoom` 的 `sorted` 是延遲重算的；`rankOf()`
  刻意不用它，改用 O(n) 直接數，因為前端的超車動畫吃這個數字，晚 200ms 就會閃錯名次。
  改 `ranking()` 時記得這件事。
- **OAuth 1.0a 簽章不簽 body。** `scripts/post-to-x.mjs` 只簽 `oauth_*` 與 query string。
  X 的 media upload 是 multipart、發文是 JSON，兩者的 body 都**不能**進 signature base string。
  簽錯的症狀是 401，而且訊息完全不提原因。
- **X 沒有免費層了**（2026-02-06 起 pay-per-use，$0.015/則）。要先在 console.x.com 儲值，
  否則 API 直接回失敗。
- **點擊要批次送。** 前端累積 100ms 或 10 次才發一個 POST，server 端 `MAX_PER_REQUEST`
  也是 10。兩邊要一起改，不然不是白擋就是白放。

- **新增使用者可見的字串時，三個語言都要加**（`en` / `zh-Hant` / `zh-Hans`）。
  字串表在 `web/i18n.js` 的 `STRINGS`，英文那組是 fallback，缺 key 不會壞但會混語言。
  HTML 靜態文案用 `data-i18n` / `data-i18n-html` / `data-i18n-aria` 標記，
  JS 產生的文案走 `t()`。
- **中文字體是 CSS 變數 `--font-cjk` 決定的**，不是靠載入 `<link>` 就會生效 ——
  字體必須真的出現在 `--font-display` / `--font-body` 的 stack 裡。
  `html[lang="zh-Hans"]` 把它換成 Noto Sans SC，`i18n.js` 只載當下需要的那一套。
- **含數字的句子不要用字串拼接。** 中英文的數字位置不同（`{n} beggars` vs
  `{n} 人跪求中`），所以那類標籤走 `fillCount()`，它會依模板重建 DOM。
- **切語言要重建 odometer。** `Intl.NumberFormat` 的分位符可能不同，直接 diff
  舊字元會錯亂 —— `repaintDynamic()` 先清空再重畫就是為此。

## 驗證

```bash
npm run serve                                   # demo 模式，開 localhost:4173
cd worker && npx wrangler dev --port 8787 --local
npm run smoke                                   # 另一個 terminal，跑 API 端對端
npm run daily:dry                               # 截圖 + 印出貼文內容，不送出
npm run lang                                    # Playwright 跑語言判斷（含 geo fallback）
```

`scripts/smoke.mjs` 不依賴起始狀態，可重複跑。它涵蓋不到 Google OAuth
（需要真的 client 與真人點同意），其餘路徑都有測。
