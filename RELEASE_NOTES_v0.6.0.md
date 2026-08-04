# Evolabs v0.6.0 — Self-managed Agent Studio

## 核心更新

- **只貼劇本的全自動流程**：Evo 導演調度編劇、美術、IP、角色、場景、分鏡、聲音與導演複審，建立共享 Production Bible 後自動準備模型與生成成片。
- **首次啟動自動前置**：Evolabs 在程式內安裝／修復 headless llmster、下載並載入 Agent 模型、啟動本機 API、執行健康檢查；使用者不需要自行安裝 LM Studio、設定模型路徑或啟動伺服器。
- **AI 視覺模型整合**：首次設定畫面內完成授權確認、續傳下載、SHA-256 驗證與原子啟用；不再把文字人物卡當作正常最終畫面。
- **Agent 製片工作台重製**：新的深色製片畫布、Agent 任務側欄、資產節點、節點檢視器、Runtime 狀態與首次啟動進度介面，取代舊式角色／分鏡表單。
- **速度不犧牲品質**：共用常駐 Agent 模型、Production Bible 計畫重用、角色身份資產快取、AI 圖片內容快取、模型續傳與 GPU 工作序列化；預設仍保留平衡品質、DPM++ 與導演驗收。
- **RTX 3050 4GB 路徑**：自動採用 batch 1、保守解析度、VAE tiling、CPU offload、GPU VRAM 預算與單 GPU worker，降低 OOM 風險。
- **程式內更新**：GitHub Actions 建置並簽署 Tauri NSIS updater；安裝 0.6.0 後，可從「設定 → 自動更新 → 更新並重啟」套用後續版本。

## 使用流程

```text
安裝 Evolabs
→ 首次開啟自動準備 Agent Runtime 與模型
→ 在 Evolabs 內確認一次視覺模型授權
→ 貼上劇本
→ 按「交給 Evolabs 團隊」
→ 自動完成製作藍圖、畫面、聲音與成片
```

## 發行說明

0.6.0 的第一個安裝器仍需透過 `SETUP_AUTO_UPDATE.bat` 建立發佈 Repository、產生 updater key，並交由 GitHub Actions 的 Windows runner 編譯與簽署。完成第一次安裝後，日常更新不再需要在使用者電腦安裝 Rust、Node.js、Python 或重新建置 EXE。
