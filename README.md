# ⚡ Mesh Sync v3 — AI 對話脈絡收藏器

開源的 Chrome 擴充功能。在 **ChatGPT / Claude / Gemini**
的對話頁面擷取重要討論片段，自動寫進**你自己 Google Drive** 的指定資料夾：

- **一場對話一份 Google Doc**：同一對話存幾次都累加在同一份文件，附時間戳
- **自動命名**：`日期_主題_平台`，例如 `20260813_品牌定位討論_ChatGPT`
- **文件底部自動附上原始討論的連結**，隨時跳回當時的對話
- **多客戶**：popup 切換客戶，寫入目標資料夾跟著切換
- **最小權限**：只用 `drive.file` scope，只碰這個擴充自己建立的檔案，看不到你 Drive 裡的其他東西

## 三種擷取方式

1. **圈選**：在對話頁面選取重要段落 → 浮出「⚡ 存入脈絡」按鈕 → 按一下寫入。
2. **AI 標記**：把下面這段 prompt 貼進 AI 的個人化設定，對 AI 說「記錄脈絡」時，
   它會在回覆結尾輸出 `[CONTEXT]` 區塊，頁面右下角跳出確認卡，按「寫入」即可。
3. **整場對話**：popup 按「📄 收錄整場對話」，把目前分頁的完整問答依序寫入同一份 Doc。

```
當我說「記錄脈絡」或這段討論產生重要結論時，
請在回覆的最後面輸出這個區塊（原樣輸出，不要解釋）。
請寫得具體：key_points 五到八條，寫出「為什麼」與推導過程，不要只寫結論標題；
quotes 摘錄我原話裡最關鍵的句子。
[CONTEXT]
{"summary":"一句話總結",
 "background":"這段討論的來龍去脈、從哪裡開始的",
 "key_points":["具體重點，含理由或推導","..."],
 "quotes":["使用者的關鍵原話"],
 "decision":"做了什麼決定",
 "open_questions":["還沒解決的問題"],
 "next_steps":["下一步要做什麼"]}
[/CONTEXT]
```

寫入時預設會一併收錄標記前的最近 6 則問答原文（popup 可調整或關閉）——
摘要是索引，原文才是脈絡。

| 平台 | 貼在哪裡 |
|---|---|
| ChatGPT | 設定 → 個人化 → 自訂指令 |
| Claude | Settings → Profile 偏好欄位，或 Project 自訂指示 |
| Gemini | 設定 → Saved Info |

標記內容不是 JSON 也沒關係，會原樣收進 Doc。安裝完成時會自動打開設定導覽頁
（`onboarding.html`）帶你做這件事。

## 安裝（學員／一般使用者）

1. 下載本專案（Code → Download ZIP，解壓縮）。
2. 打開 `chrome://extensions`，右上角開啟「開發人員模式」。
3. 按「載入未封裝項目」，選取 `extension/` 資料夾。
4. 點擴充圖示 → 「連接 Google」→ 用自己的 Google 帳號登入授權。

manifest 內含固定的 `key`（公鑰），所以每個人載入後的擴充 ID 都相同：
`mgeigmfkagbfbgngheecjlcdiemajpdg`，共用同一個 OAuth client 才會成立。

## OAuth 設定（維護者做一次，全部使用者受益）

使用者按「連接 Google」時走的是標準 Google 登入，背後需要一個 OAuth client。
維護者設定一次即可：

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案。
2. 「API 和服務」→ 啟用 **Google Drive API** 與 **Google Docs API**。
3. 「OAuth 同意畫面」：使用者類型選「外部」，填 App 名稱與聯絡信箱。
   scope 只需要 `.../auth/drive.file`（**非敏感** scope，發布正式版不需要 Google 審查，
   也沒有測試使用者 100 人上限）。填完把發布狀態改成「正式版」。
4. 「憑證」→ 建立憑證 → OAuth 用戶端 ID → 應用程式類型選「**Chrome 擴充功能**」，
   項目 ID 填 `mgeigmfkagbfbgngheecjlcdiemajpdg`。
5. 把拿到的 client ID 填進 `extension/manifest.json` 的 `oauth2.client_id`。

> **想完全自主？** 你也可以不用維護者的 client：自己走一次上面五步
> （client_id 換成你自己的即可），資料流從頭到尾都只經過你自己的 GCP 專案。
> client_id 是公開資訊，Chrome 擴充的 OAuth client 沒有 secret，寫在開源 repo 是標準做法。

## 專案結構

```
extension/
├── manifest.json        # MV3，含固定 key（公鑰）與 oauth2 設定
├── popup.html           # 多客戶切換、連線狀態、prompt 複製、寫入紀錄
├── onboarding.html      # 安裝後自動打開的設定導覽
├── icons/
└── src/
    ├── background.js    # OAuth、Drive 資料夾／Doc 管理、片段累加寫入
    ├── content.js       # 圈選按鈕＋ [CONTEXT]/[SYNC] 標記偵測
    ├── popup.js
    ├── onboarding.js
    └── toast.css
```

- `key.pem`（專案根目錄、不進 git）：打包 .crx 時才需要的私鑰。載入未封裝不需要它。

## 隱私

完整隱私權政策：<https://joanna8521.github.io/MeshSync/privacy.html>（[docs/privacy.html](docs/privacy.html)）

- 擷取動作**全部由使用者手動確認**（按「存入脈絡」或確認卡的「寫入」），不會自動上傳任何內容。
- 資料只寫進使用者自己的 Google Drive；本擴充沒有任何自己的伺服器。
- `drive.file` scope 之下，擴充只能看到、修改它自己建立的資料夾與文件。

## 已知限制

- 各平台的 DOM 結構改版可能讓「標記自動偵測」失效（selector 在 `content.js` 的
  `SELECTORS`），圈選模式不受影響。
- Gemini 的對話網址需要該對話已在網址列出現（`gemini.google.com/app/<id>`）。
- 換機器或重灌後，「一場對話一份 Doc」的對應表（存在 `chrome.storage.local`）不會跟著走，
  同一場對話會開新的 Doc。

## License

MIT
