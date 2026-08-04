# Evolabs 0.4.2 — Windows 建置復原與角色語音正式接線

## 這次真正完成的項目

### 1. Windows 一鍵來源建置器不再綁死舊版 Node

- 移除 `OpenJS.NodeJS 24.0.0` 的固定 WinGet 解析。
- 缺少 Node.js 24 時，直接下載 Node 官方 `latest-v24.x` Windows x64 可攜 ZIP。
- 下載前讀取官方 `SHASUMS256.txt`，下載後核對 SHA-256，驗證成功才解壓到 `.build\toolchain`。
- 建置工具鏈會主動尋找專案本機 Node；不需要系統安裝，也不需要為 Node 顯示 UAC。

### 2. Rustup 雙路徑復原

- 先嘗試官方 WinGet 套件 `Rustlang.Rustup`。
- WinGet 不存在、回傳失敗，或回報完成後仍找不到 Rustup 時，自動改用 Rust 官方 `rustup-init.exe`。
- bootstrapper 下載後核對官方 SHA-256，並以 minimal profile、`x86_64-pc-windows-msvc` host 安裝。
- 隨後仍會實際執行並驗證 stable MSVC toolchain、Cargo 與 Windows x64 target，不會只因安裝程式退出碼為 0 就宣告成功。

### 3. 角色聲音從灰色占位變成真功能

- 角色頁的「青年・自然／少女・清冷／中性・自然／成熟・沉穩」現在可選擇並保存。
- 單角色鏡頭直接使用該角色風格。
- 多角色鏡頭若對白以 `角色名：` 或 `角色名:` 開頭，會選擇該角色；無法確定說話者時回退到中性風格。
- 字幕仍保留角色署名，但配音會移除已辨識的 `角色名：`、`旁白：`、`畫外音：` 或 `內心：` 前綴，避免每句都把姓名念出來。
- Windows Engine 會優先尋找同名 SAPI voice；一般風格則依中文語音的性別與語速選擇，並在工作狀態留下實際 `voiceProfile`。
- 前端橋接層會驗證 `voiceProfile`，並在鏡頭佇列顯示實際套用的聲線；未知舊值不會直接進入 UI。
- 一個分鏡仍只有一段對白音軌，因此本版不假裝在同一段文字中完成多人輪流配音。

### 4. 取消與錯誤狀態修正

- 取消 MuseTalk 工作時，現在回報 `LIPSYNC_CANCELED`。
- 不再因取消訊號發生在 Provider probe 階段，而誤顯示 `LIPSYNC_NOT_READY`。
- 取消後仍會清理暫存輸出，不提交半成品。

### 5. 可重現性與發行一致性

- App、Engine、Tauri、Cargo lock、npm lock、UI、BAT 與協議最低版本統一為 `0.4.2`。
- `package.json` 的直接依賴由 `latest` 改成 lockfile 中的精確版本。
- GitHub Actions 同時收集 target-specific 與舊式 NSIS 輸出目錄。
- Windows 腳本測試新增官方校驗、可攜 Node、Rust 備援與禁止舊版硬編碼的檢查。

## 驗證範圍

- Python Engine 完整測試：74 項以上。
- 真實 FFmpeg MP4 生成與完整解碼 smoke。
- 角色語音解析：單角色、多人署名、多人不明確回退。
- MuseTalk 取消狀態與清理。
- JSON、Python compile、版本一致性、發行清單與壓縮包內容檢查。

Windows NSIS 最終 `.exe` 仍必須在 64 位元 Windows 上執行 `BUILD_WINDOWS.bat` 產生；來源包不會把尚未於 Windows 建置的檔案偽裝成安裝器。
