# Evolabs v0.5.0 — Agent Studio

## 從「分鏡卡播放器」改成多智慧體製片團隊

0.5.0 的主要入口只要求使用者貼上劇本。Evo 導演會依序調度編劇、美術總監、IP 設計、角色設計、場景設計、分鏡與聲音 Agent，建立結構化 Production Bible，完成後自動進入模型準備與成片生成。

### Agent 交付物

- 劇本分析：角色種子、地點需求、衝突、節奏與故事節點；
- 視覺聖經：色彩、材質、光線、攝影語言與全局負面規則；
- IP／連戲聖經：角色不變項、服裝、道具、空間與禁止漂移規則；
- 角色資產：身份錨點、外觀／負面 Prompt、服裝、表情與聲線；
- 場景資產：地點、時間、天氣、燈光、固定道具與空間錨點；
- 分鏡：景別、構圖、動作、情緒、起訖畫面、運鏡、時長與轉場；
- 聲音設計：配音、環境聲、音效與配樂方向；
- 導演複審：矛盾檢查、修正與批准。

## 畫布與 Agent UI

- 初始畫面是單一劇本輸入與「交給 Evolabs 團隊」。
- 左側顯示 Agent 團隊、工作狀態、交付進度與導演指示。
- 中央無限畫布顯示劇本、角色、場景、分鏡、聲音、複審與成片的依賴關係。
- 使用者可檢視每個 Agent 的產物，但不需要自己接低階節點。

## 本機 Agent

- 支援 LM Studio 的 loopback OpenAI 相容端點。
- 每個 Agent 有獨立 JSON 合約、輸入上限與安全 system prompt。
- 若單一階段輸出失敗，只回退該階段的內建專家，不中斷整部作品。
- 沒有本機 LLM 仍可完成完整可執行製作藍圖。

## 角色一致性加強

- Engine 在逐鏡生成前先建立每位角色的身份參考資產。
- 場景 Prompt 同時繼承美術、IP、Location、Character 與 Storyboard 資訊。
- 角色身份資產與逐鏡圖片支援內容快取；第二次相同工作可直接重用。
- 角色資產進度與實際路徑會寫入 Render status，供 Agent Canvas 顯示。

## 簽章式自動更新

- 新增 Tauri updater、Windows passive install mode 與程式內「更新並重啟」。
- 新增 `SETUP_AUTO_UPDATE.bat`：一次建立 GitHub Release 更新通道與 updater key，等待第一個雲端 Release，下載 Setup.exe 並詢問是否立即安裝。
- 新增 `PUBLISH_UPDATE.bat`：之後會自動建議下一個修訂版，版本與摘要都可直接按 Enter；GitHub Actions 自動建置、測試、簽署與發佈。
- GitHub Action 產生 NSIS installer、signature 與 `latest.json`。
- 私鑰保存在發佈者使用者目錄與 GitHub Actions Secret，不進入 repository 或前端 bundle。

## Windows 與 UTF-8 修復

- 所有 Distribution profile、pack manifest 與 Engine smoke status 都以明確 UTF-8 讀取，避免 Windows PowerShell 5.1 依 ANSI code page 破壞中文 JSON。
- Windows GPU file lock 的 metadata 與 lock byte 分離，解決同程序 owner PID 讀取與 `PermissionError`。

## 驗證目標

- TypeScript strict build；
- 前端 Agent／migration／bridge／App 測試；
- Engine cache、provider、installer、process control、renderer、聲線、對嘴與 MP4 整合測試；
- 模型 manifest、版本一致性與 source release validator；
- GitHub Actions Windows NSIS 與 signed updater artifacts。

## 仍需誠實說明

0.5.0 的本機 4GB GPU 路徑仍以 AI 關鍵畫面加可控鏡頭運動為主，不把大型逐幀 I2V、多人精準臉部鎖定或未完整授權的語音／對嘴模型冒充為已交付功能。
