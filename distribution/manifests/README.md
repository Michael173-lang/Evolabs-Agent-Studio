# Evolabs verified optional still-image packs

本目錄保存的是經大小、SHA-256、授權與啟用規則驗證的**選配靜態圖片包**。
模型權重不會被放進來源碼或 NSIS 安裝程式。

- `models/anime-core.json`：舊版 SD 1.5 動漫靜態圖片包，只能用於動態漫畫或影片首幀參考素材。
- `models/realistic-core.json`：舊版 SD 1.5 寫實靜態圖片包，只能用於動態漫畫或影片首幀參考素材。
- 兩個模型包都**不是影片模型**，不會產生連續動作，也不是「AI 影片」模式的必要元件。
- Evolabs 的 AI 影片模式必須連接能真正輸出影片的本機 ComfyUI API 工作流；靜態圖片工作流不得冒充影片模式。

安裝器會把模型版本寫入 `<engine-data-root>/models/<pack-id>/<version>`，建立經驗證的
`pack.json`，再原子切換 `<pack-id>/current.json`。只有 manifest 存在並不代表模型已可用。

發行前執行 `scripts/validate-distribution.ps1`。任何上游檔案異動都必須使用新版本、精確大小、
重新驗證的 SHA-256 與更新後的授權審查；不得為了通過下載而任意更換摘要值。
