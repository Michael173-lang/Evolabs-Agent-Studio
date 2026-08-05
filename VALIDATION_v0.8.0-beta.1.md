# Evolabs v0.8.0-beta.1 驗證紀錄

## 已完成

- 發行來源與版本一致性驗證：通過。
- Python Engine 測試：82 項通過，另有 12 項子測試通過。
- Python 語法編譯檢查：通過。
- TypeScript 嚴格型別檢查：`npm run check` 通過。
- TypeScript 結構測試：41 項通過，涵蓋真實 Agent 對話、模型證據過濾、提案安全、影片模式隔離、角色參考圖生成前檢查、逐鏡輸出隔離、人物年齡／服裝鎖定與舊專案遷移；正式 Vitest 仍交由 Windows CI。
- Git 差異空白與衝突檢查：通過。
- 舊版 schema v1 的 `ai-video` 標籤會安全降級為動態漫畫；只有 schema v2 專案可保留真正 AI 影片模式。
- AI 對話、任務確認、專案修改提案、ComfyUI 影片工作流驗證及逐鏡人工審核均有對應測試或結構驗證。

## 此環境尚未完成

- 正式 `npm ci`、Vite production build 與 Vitest：目前執行環境無法存取專案套件 registry。
- Rust/Tauri 編譯與測試：目前執行環境未安裝 Rust toolchain。
- Windows NSIS 安裝程式與 updater 簽章：必須交由乾淨 Windows runner 建置。
- RTX 3050 4 GB 真正影片工作流實機成片驗證：仍為升級穩定版前的必要項目。

因此本來源候選版只能標示為 Beta，不得宣稱為已完成的穩定發行。
