# Evolabs Agent Studio

**Evolabs 0.6.0** 是一款黑色極簡、本機優先的 Windows 多智慧體短劇工作室。

使用方式只有一個主要動作：

```text
貼上完整劇本
      ↓
按「交給 Evolabs 團隊」
      ↓
Agent 團隊自動完成製作聖經、角色、場景、分鏡、聲音規劃與成片
```

0.6.0 不再把使用者丟進「角色表單 → 分鏡表單 → 參數表單」的傳統工作流。畫布會顯示每位 Agent 的交付物與連線，但日常使用者不需要自己接節點、寫圖片 Prompt、配置模型或逐鏡建立任務。

## 多智慧體製片團隊

| Agent | 自動負責 |
|---|---|
| **Evo 導演** | 調度全部 Agent、檢查矛盾、提出修正、批准進入生成 |
| **編劇師** | 解析角色、衝突、節奏、故事節點、地點需求 |
| **美術總監** | 建立全片風格、色彩、材質、光線與攝影規則 |
| **IP 設計師** | 鎖定世界觀、服裝、道具、連戲與禁止漂移規則 |
| **角色設計師** | 建立身份錨點、外觀 Prompt、固定服裝、表情與聲線 |
| **場景設計師** | 建立地點資產、時間、天氣、光線、道具與空間錨點 |
| **分鏡師** | 自動拆鏡、景別、構圖、動作、情緒、運鏡、時長與轉場 |
| **聲音導演** | 規劃配音、旁白、環境聲、音效與配樂方向 |

每一階段都有結構化 JSON 合約。首次開啟時，Evolabs 會自行安裝 LM Studio 官方的無介面 **llmster**、下載適合 RTX 3050 4GB 的 Qwen3 4B 量化模型、啟動僅限本機的 API，並逐階段讓模型擔任 Agent。使用者不用安裝或開啟 LM Studio，也不用設定 API、模型路徑或環境變數。若某一階段回傳格式錯誤，只有該階段會改用內建專家，不會讓整部作品重來。

## OiiOii 類型的製片體驗，不複製其專有內容

0.6.0 的產品方向是「一句劇本交給一個小型 AI 製片團隊」，並採用劇本、角色、場景、分鏡、聲音與最終合成的畫布式工作流。Evolabs 是獨立實作：沒有複製 OiiOii 的私有模型、Prompt、品牌素材或原始碼。

畫布中的主要資產鏈如下：

```text
原始劇本
  → 劇本分析
  → 視覺聖經 ─┐
  → IP／連戲聖經 ├→ 角色資產 ─┐
                  └→ 場景資產 ─┼→ 分鏡鏡頭 → 聲音設計 → 導演複審 → 成片
```

## 角色一致性與本機生成

在正式逐鏡生成前，Engine 會先為每個角色建立可重用的身份參考資產。後續每一鏡會繼承：

- 全片美術方向與負面規則；
- IP／連戲聖經；
- 地點、時間、天氣、光線與固定道具；
- 角色身份錨點、服裝、外觀負面 Prompt；
- 分鏡構圖、動作、情緒、鏡頭運動與轉場。

動漫／寫實模式都能使用 stable-diffusion.cpp、IP-Adapter Plus 與 CLIP Vision；4GB 顯存路徑會序列化 GPU 工作，採用 VAE tiling、CPU offload 與保守尺寸，避免多個 Agent 同時把顯存壓爆。

### 現階段的真實邊界

- 目前的影片核心是 **AI 靜態關鍵畫面＋可控鏡頭運動＋字幕／音訊＋FFmpeg 合成**，不是大型逐幀 I2V。
- IP-Adapter 在安全路徑一次精準處理一位主要參考角色；多人同鏡仍主要依賴文字身份錨點。
- Windows 中文系統語音可用時會依角色聲線配音；沒有可用語音時保留字幕與安靜音軌。
- MuseTalk 是選配的本機自備 Provider，只在完整 Runtime、CLI、CUDA 與單一可見說話者條件成立時啟用。
- Agent 大腦由 Evolabs 自動管理；若 llmster 安裝、下載或載入暫時失敗，使用者仍可先進入工作室並使用內建 Agent 備援，之後按一次「自動修復」續傳。


## 速度與品質策略

Evolabs 不用「把步數砍到很低」來假裝變快。預設的 **平衡** 品質保留 DPM++ 畫面生成與完整導演驗收，速度主要來自：

- Agent 模型一次載入，八個專業階段共用同一個本機服務；
- 劇本、設定與導演指令未改時，直接重用已驗收的 Production Bible；
- 角色身份參考先生成一次，所有鏡頭共享，不重複設計人物；
- AI 圖片以完整 Prompt、模型雜湊、參考圖與生成參數做內容定址快取；
- 已完成的模型包、下載分段與輸出快取會續用；
- RTX 3050 4GB 只序列化真正佔用 GPU 的工作，劇本分析、音訊與 FFmpeg 可在安全範圍並行。

因此第一次建立資產最久；同一專案重做、重新輸出或只改少量內容會明顯更快，而不是用低品質文字卡片取代畫面。

## 一鍵自動前置作業

首次啟動的 Runtime Manager 會在 Evolabs 視窗內完成：

1. 偵測 GPU、VRAM、RAM、磁碟與本機 Engine；
2. 安裝或修復官方 headless llmster；
3. 下載 `qwen/qwen3-4b-2507@q4_k_m` 作為 Agent 大腦；
4. 以固定識別碼、8K 上下文、GPU 自動卸載與閒置自動釋放模式載入；
5. 啟動只綁定 `127.0.0.1:1234` 的本機 API；
6. 在 App 內完成視覺模型授權、續傳下載與 SHA-256 驗證；
7. 套用 RTX 3050 4GB 的單 GPU 工作佇列、VAE tiling、CPU offload 與快取重用。

所有已完成的元件都會重用。重新開啟 Evolabs 時只做健康檢查，不會重新下載。

## 更新方式：首次安裝一次，以後程式內更新

0.6.0 已加入 Tauri 簽章式更新器與 GitHub Actions 發佈管線。

### 發佈者第一次只做一次

雙擊：

```text
SETUP_AUTO_UPDATE.bat
```

瀏覽器登入 GitHub 後，repository 欄位可直接按 Enter 使用預設的公開專案。腳本會：

1. 自動補齊 GitHub CLI、Git、Node.js 與 Python 3.11；
2. 建立或連接公開 GitHub repository；
3. 產生 Evolabs updater 金鑰；
4. 把私鑰只保存到 `%USERPROFILE%\.evolabs\updater`，並送入 GitHub Actions Secret；
5. 把公開金鑰與 `latest.json` 端點寫入 App；
6. 推送來源碼與 `v0.6.0` tag；
7. 等待 GitHub 在雲端完成測試、Windows 建置、簽署與 Release；
8. 自動把第一個 `Setup.exe` 下載到 `release-downloads\v0.6.0`，並詢問是否立即安裝。

這是最後一次需要安裝完整 Setup。從這個版本開始，Evolabs 啟動時會自動檢查更新；有新版時只要在程式內按：

```text
設定 → 自動更新 → 更新並重啟
```

### 後續發佈新版

雙擊：

```text
PUBLISH_UPDATE.bat
```

版本欄位會自動建議下一個修訂版；直接按 Enter 即可。腳本會同步所有版本欄位、建立版本說明、執行來源驗證、提交、打 tag、推送並等待 GitHub Actions。Windows EXE、更新簽章、`latest.json` 與 Release 全部由雲端建立，不再要求你的電腦重新跑整套 Rust／Python／Tauri 封裝。

完整說明與金鑰備份要求見 [AUTO_UPDATE_SETUP.md](AUTO_UPDATE_SETUP.md)。

> Tauri updater 簽章用來驗證「更新確實由你發佈且未被竄改」。它和 Windows Authenticode／SmartScreen 信譽是兩件不同的事；公開散布時仍建議另外取得 Windows 程式碼簽章憑證。

## 一般使用者

一般使用者只安裝已發佈的 NSIS `Setup.exe`，不需要 Node.js、Python、Rust、Visual Studio 或 LM Studio。第一次開啟時，App 會用單一進度畫面自動準備 llmster、Agent 模型、本機 API 與 Engine；接著在 App 內確認一次視覺模型授權，便會自動下載、續傳、驗證並啟用模型包。完成後的日常操作只有「貼劇本 → 交給 Evolabs 團隊」。

| 模型包 | 約略下載量 | 用途 |
|---|---:|---|
| 動漫 AI 核心 | 約 5.12 GB | 動漫畫面＋角色參考 |
| 寫實 AI 核心 | 約 2.83 GB | 寫實畫面＋專用 VAE |

## 從來源碼建立 Windows 安裝器（開發者救援用）

正常更新不再需要執行來源建置器。只有開發、離線驗證或 GitHub Actions 故障時才雙擊：

```text
BUILD_WINDOWS.bat
```

它會檢查／補齊 Node.js 24、Python 3.11 x64、Rust stable MSVC、Visual Studio C++ Build Tools、Windows SDK 與 WebView2，然後執行來源驗證、TypeScript、前端測試、Engine 測試、PyInstaller、MP4 smoke test、Tauri 與 NSIS。

成功輸出通常位於：

```text
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\
```

## 開發與測試

```powershell
npm ci
npm run check
npm test
$env:PYTHONPATH="engine/src"
python -m unittest discover -s engine/tests -v
python scripts/validate-engine-manifests.py --manifest-root distribution/manifests
python scripts/validate-source-release.py
```

瀏覽器 UI 預覽：

```powershell
npm run dev:web
```

瀏覽器模式只模擬工作狀態；只有 Tauri Windows App 會執行本機 Engine、模型安裝與 MP4 輸出。

## 資料與安全

- 專案、角色資產、模型、快取與輸出保存在 Evolabs 的 Windows AppData。
- Agent 的本機 OpenAI 相容端點只允許 `127.0.0.1`、`localhost` 或 `::1`。
- 模型只接受固定 HTTPS 來源；每次轉址也必須保持 HTTPS。
- 模型與 Runtime 下載後驗證完整大小、SHA-256、檔案集合與安全解壓限制。
- 最終 MP4 完整解碼成功後才會原子提交。
- 更新必須通過 Tauri 公開金鑰簽章；更新端點必須是 HTTPS。
- 私密 updater key 不得放入專案、Vite 變數或任何可被前端打包的檔案。

更多細節見 [ARCHITECTURE.md](ARCHITECTURE.md)、[RELEASE_NOTES_v0.6.0.md](RELEASE_NOTES_v0.6.0.md) 與 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
