# Evolabs 自動更新：一次設定，之後一鍵發佈

## 目的

完成這個一次性設定後：

```text
你修改來源碼
  → 雙擊 PUBLISH_UPDATE.bat
  → 直接按 Enter 採用建議版本
  → GitHub 自動建置與簽署
  → 已安裝的 Evolabs 顯示「有新版本」
  → 使用者按「更新並重啟」
```

不需要在日常更新時再次安裝 Rust、覆蓋 `.ps1`、執行本機 NSIS 建置或把 EXE 手動傳給每個人。

## 第一次設定

### 必要條件

- Windows 10／11；
- 一個 GitHub 帳戶；repository 可讓腳本自動建立，不必事先準備；
- 網路連線。

公開 repository 是 GitHub Releases 免登入更新的必要條件。來源碼也會被推送到該 repository。需要私有來源碼時，應改用獨立公開 release repository 或 Cloudflare R2 update service；本版一鍵腳本不會暗中把 private release 當成可公開下載。

### 執行

雙擊：

```text
SETUP_AUTO_UPDATE.bat
```

瀏覽器登入 GitHub 後，repository 提示可直接按 Enter，使用：

```text
你的 GitHub 名稱/Evolabs-Agent-Studio
```

也可以輸入自己的 `owner/repo`。腳本會自動：

1. 檢查並安裝官方 GitHub CLI；
2. 開啟 GitHub 網頁登入；
3. 建立或連接公開 repository；
4. 執行 `npm ci` 取得專案固定版本的 Tauri CLI；
5. 產生 updater key pair；
6. 把私鑰放在 `%USERPROFILE%\.evolabs\updater\evolabs-updater.key`；
7. 將私鑰以 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY` 保存；
8. 將公開金鑰與 `https://github.com/owner/repo/releases/latest/download/latest.json` 寫入 App；
9. 執行來源驗證；
10. 推送 `main` 與 `v0.6.0` tag，啟動第一個 Release build；
11. 等待 GitHub Actions 完成；
12. 自動下載 NSIS `Setup.exe` 到 `release-downloads\v0.6.0`，並詢問是否立即啟動安裝。

GitHub Release 會同時包含 NSIS `Setup.exe`、updater signature 與 `latest.json`。

## 第一次安裝

舊版 Evolabs 沒有新公開金鑰，因此 0.6.0 仍需要安裝一次完整 `Setup.exe`；但不必自己尋找 Release，`SETUP_AUTO_UPDATE.bat` 會在雲端建置成功後自動下載並詢問是否安裝。

從這個安裝版本開始，後續更新可在 App 內完成：

```text
設定 → 自動更新 → 檢查更新 → 更新並重啟
```

## 發佈後續版本

修改完成後雙擊：

```text
PUBLISH_UPDATE.bat
```

畫面會建議下一個修訂版，例如：

```text
New Evolabs version [下一個修訂版]
```

直接按 Enter 採用建議版本；版本摘要也可按 Enter 使用預設內容。腳本會：

- 同步 npm、Tauri、Cargo、Engine、協議、UI 與 BAT 版本；
- 建立 `RELEASE_NOTES_v<版本>.md`；
- 執行來源一致性驗證；
- commit 並建立 `v<版本>` tag；
- push 至 GitHub；
- 等待 GitHub Actions 完成，成功後顯示已發佈。

GitHub Actions 會在乾淨 Windows runner 上執行前端與 Engine 測試，然後建置、簽署、產生 `latest.json` 並發佈。你的電腦不再本機重建 EXE。

## 最重要的備份

請備份整個資料夾：

```text
%USERPROFILE%\.evolabs\updater
```

特別是：

```text
evolabs-updater.key
```

不要：

- 上傳到 Discord、雲端公開連結或 GitHub；
- 放進專案資料夾；
- 放進 `VITE_` 或任何前端環境變數；
- 刪除唯一備份。

遺失私鑰後，新的更新無法被已安裝版本的公開金鑰接受。這不是「重新產生一把」就能無痛修復的設定。

## 更新簽章與 Windows 程式碼簽章

Tauri updater key 驗證更新來源與完整性，但不等於 Windows Authenticode。未購買 Windows 程式碼簽章憑證時，第一次下載的安裝器仍可能看到 SmartScreen 提示。這不影響 Evolabs 內部 updater 的簽章驗證，但正式大量公開時仍建議加上 Authenticode。

## 故障處理

### GitHub Actions 沒有開始

確認 repository 的 Actions 已啟用，並確認 tags 頁面存在目前版本或新版本 tag。

### Build 顯示缺少 `TAURI_SIGNING_PRIVATE_KEY`

再次執行 `SETUP_AUTO_UPDATE.bat`。它會重用本機 key pair，重新寫入 GitHub Secret，不會自動更換公開金鑰。

### App 顯示「待首次綁定」

代表你安裝的是尚未寫入 endpoint／公開金鑰的 build。重新執行 `SETUP_AUTO_UPDATE.bat`；它會等待 GitHub Release 成功、下載正確的 Setup.exe，並詢問是否立即安裝。

### Repository 是 private

把它改為 public，或自行部署帶授權的 update service。安裝在一般使用者電腦上的 App 不應內嵌 GitHub Personal Access Token。
