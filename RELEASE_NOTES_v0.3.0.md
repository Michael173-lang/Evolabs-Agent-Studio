# Evolabs 0.3.0 — 本機 AI 畫面版

## 新增

- 真正的動漫／寫實逐鏡 AI 圖片生成，不再只是分鏡卡。
- stable-diffusion.cpp CUDA 12 一鍵模型安裝器。
- 動漫角色參考圖、單角色 IP-Adapter 一致性與強度控制。
- 模型授權確認、下載續傳／取消、SHA-256、安全解壓及原子啟用。
- 所有下載轉址逐跳限制 HTTPS；模型與 Runtime 在執行前再次驗證完整檔案集合、大小與 SHA-256。
- 既有模型重新驗證與損壞自動修復；重開機孤兒安裝不再鎖住佇列。
- 模型／硬體／磁碟 capability gating；未就緒時禁止開始 AI 工作。
- 跨工作 AI 圖片內容快取。
- 可選的本機 AUTOMATIC1111／Forge loopback Provider。
- Windows 來源碼建置器會偵測並嘗試透過 WinGet 安裝 Rust stable MSVC、Visual Studio C++ Build Tools、固定主版本的 Node.js 24、Python 3.11 x64 與 WebView2；若 UAC、重新開機或套件錯誤需要人工處理，會顯示官方入口而不誤報成功。

## 驗證

- 20 項前端測試。
- 41 項 Engine／媒體／Provider／Installer 測試。
- Windows MSVC target 的 Rust `cargo check`。
- Production web build。
- Windows 建置時額外執行 PyInstaller Engine 健康檢查與真實 MP4 smoke test。

## 已知限制

- 尚未在此 Linux 交付環境用真正 RTX 3050 Laptop 4GB 與完整 5.12 GB 模型實測；需在使用者 Windows 電腦完成最終硬體驗收。
- 每個未命中快取的鏡頭會重新載入 `sd-cli`，以降低 4GB 常駐 OOM 風險。
- IP-Adapter 一次只鎖定一名參考角色。
- 寫實模式尚未套用參考圖條件。
- 目前沒有自動對嘴或逐幀 I2V。
- 中文配音依賴 Windows 已安裝的中文 SAPI 語音。
