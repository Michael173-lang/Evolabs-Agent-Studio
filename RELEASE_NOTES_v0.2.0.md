# Evolabs 0.2.0 — 功能核心版

## 這版真的能做什麼

- Windows App 以獨立本機 Engine 生成 H.264／AAC MP4，不再使用前端假進度。
- 每鏡建立 720p 分鏡卡，加入推進、淡入淡出、字幕與音軌，再合併及完整解碼驗證。
- Windows 有啟用的中文 SAPI 語音時自動配音；沒有時以字幕與安靜音軌完成。
- 支援前 3 鏡測試、暫停、繼續、取消、App 重開接回工作及孤兒工作復原。
- 專案依序原子存檔並保留上一版；成功、取消或失敗後清除大型工作暫存。
- Windows 建置會自動檢查或透過 WinGet 補齊官方建置工具，封裝 Engine／FFmpeg、實際生成兩鏡 MP4、交叉驗證 release 模型清單與所有 Engine 檔案雜湊，再建立 NSIS 安裝器及其 SHA-256 檔。

## 還沒有接上的能力

- AI 角色圖、場景圖與角色一致性模型
- 專用中文 TTS、多人聲線與對嘴
- 寫實／動漫 AI 畫面模型包與真正 I2V
- 單鏡增量重生與內容位址快取
- 經過 Windows 11＋RTX 3050 實機簽署安裝驗證的正式 `.exe`

本交付是完整原始工程與 Windows 自動建置流程。必須在 Windows 建置電腦執行 `BUILD_WINDOWS.bat` 才會產生安裝器。

目前工程尚未包含由 Windows Rust 工具鏈產生的 `src-tauri/Cargo.lock`。正式發行前必須在 Windows 產生並提交 lockfile、固定 Rust toolchain，再以 `cargo check --all-targets` 與 MSVC release build 驗證；本 Linux 環境沒有 Rust／WebView2／NSIS，不能把這項驗證標示為已通過。

孤兒工作復原會以 Engine PID 與狀態心跳做 best-effort 判斷；極少數「重新開機後 PID 剛好被其他程序重用」的情況仍可能需要返回上一頁並重新開始工作。正式發行版應再比對 Windows 程序建立時間與 Engine 可執行檔路徑。
