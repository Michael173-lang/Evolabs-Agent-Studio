# Evolabs 0.6 Agent Studio 架構

## 1. 產品入口：只交劇本，不是填參數表

使用者提供 `story` 後，`startAutopilot()` 建立新的 Agent run。前端依序調度專家階段，將每個交付物寫入 `ProductionBible`，並把狀態、依賴與預覽映射到製片畫布。

```text
story
  ├─ screenwriter        → ScriptAnalysisArtifact
  ├─ art-director        → ArtDirectionArtifact
  ├─ ip-designer         → IpBibleArtifact
  ├─ character-designer  → Character[]
  ├─ scene-designer      → LocationAsset[]
  ├─ storyboard-artist   → Scene[]
  ├─ sound-director      → SoundPlanArtifact
  └─ director-review     → DirectorReviewArtifact
```

導演複審通過後，系統自動進入模型準備與 Render。使用者可以在左側 Agent 對話區追加導演要求，但日常流程不需要手動建立角色、接節點、寫 Prompt 或逐鏡設定參數。

## 2. Self-managed Runtime Manager

第一次開啟時，Tauri `runtime_manager` 會在 Evolabs 視窗內完成 Agent 前置環境，不要求使用者另外操作 LM Studio：

```text
硬體與既有服務檢查
  → 尋找 lms／llmster
  → 必要時執行 LM Studio 官方 Windows headless installer
  → 啟動 llmster daemon 與 127.0.0.1:1234 API
  → 下載 Qwen3 4B Instruct 2507 Q4_K_M
  → 以 evolabs-agent 固定識別碼載入
  → 設定 8192 context、GPU auto、閒置卸載
  → 驗證 /v1/models
```

安裝、下載、載入與健康檢查透過 `evolabs://runtime-setup` 事件回報前端；狀態與命令日誌寫入 App local data。失敗時保留進度，使用者可在同一視窗按「重新修復」，不需要碰 PATH、PowerShell、模型資料夾或 API 位址。

Agent runtime 與 AI 視覺模型是兩條獨立準備鏈。文字 Agent 就緒後，首次啟動畫面會在 App 內要求一次模型授權確認，再呼叫既有的安全模型安裝器下載、續傳、驗證並啟用圖像模型。只有兩條鏈都就緒，才把首次設定標記為完成。

## 3. Agent 執行策略

### 真實本機模型路徑

Tauri `run_agent_stage` 只允許連接 loopback 的 OpenAI 相容端點。每一位 Agent 都有獨立系統指令、專業上下文、輸入大小限制與 JSON 合約。優先要求 `response_format: json_object`；若 Runtime 不支援，會以同一階段的普通 Chat Completion 重試，最後才交給 normalizer。

所有 Agent 共用已載入的 `evolabs-agent` 模型，避免每個階段重複載入權重。模型識別碼固定，因此 App 不會誤用使用者電腦上其他已載入模型。

### 逐階段安全回退

`src/lib/agentPipeline.ts` 提供決定性 fallback。只有在單一階段逾時、回傳格式不合法或 Runtime 暫時不可用時，才由該階段的內建專家接手；其他 Agent 已完成的交付物不會被清除。所有模型輸出先經 normalizer，限制陣列大小、字串長度、ID、場景數量與引用關係。

### 計畫重用

當劇本、作品方向、比例、長度與導演指令未變，且 Production Bible 已通過導演驗收，重新生成會重用既有 Agent 計畫，直接進入模型／Render 階段。這避免八個專業階段在同一版本劇本上重跑，速度提升來自有效快取，而不是降低生成品質。

## 4. Production Bible

`ProductionBible` 是各 Agent 共用的製作真相來源：

- `script`：標題、Logline、角色種子、地點種子、故事節點；
- `artDirection`：全片風格、調色盤、材質、光線、鏡頭與負面規則；
- `ipBible`：世界規則、角色不變項、連戲規則、禁止改動；
- `locations`：固定空間、時間、天氣、燈光、道具與提示詞；
- `sound`：配音、環境音、音效與配樂方向；
- `directorReview`：問題、修正與批准狀態。

角色與 Scene 仍保留在專案一級，方便舊專案遷移、UI 顯示與 Engine 消費。

## 5. Agent Canvas 與工作區

畫布不是讓普通使用者自行拼接的低階節點編輯器，而是 Agent 製作進度與交付物的可視化：

```text
Script → Analysis → Art/IP → Character/Location assets → Shots → Sound → Review → Render
```

- 左側：Agent 團隊、目前任務、對話與失敗接手狀態；
- 中央：可縮放／拖曳的製片畫布與資產節點；
- 右側檢視：選取節點的角色、場景、鏡頭或審核細節；
- 頂部：專案狀態、Runtime／模型健康、更新入口；
- 首頁：只保留劇本、作品方向、比例、長度與「交給 Evolabs 團隊」。

節點保存 `agentId`、狀態、進度、依賴關係、摘要與預覽路徑。角色身份資產與逐鏡預覽生成後，會回寫相應節點，而不是只顯示文字占位卡。

## 6. Engine 角色身份資產

Engine 在正式場景生成前執行 `_prepare_character_assets()`：

1. 根據角色身份錨點、固定外觀、服裝、美術聖經與負面提示建立角色參考請求；
2. 以內容導向 cache key 生成或重用單角色身份圖；
3. 保存至 Engine data root 的 `assets/characters/<project-hash>`；
4. 把實際資產摘要寫入 job status；
5. 每個相關 Scene 以該資產作為 IP-Adapter 參考。

場景 Prompt 會合併美術、IP、Location、Character 與 Storyboard 五層資料，而不是只把原始劇本文字丟給圖片模型。

## 7. Render 隔離與狀態

Tauri 保存唯讀專案快照並啟動獨立 Engine：

```text
Production Bible + Characters + Scenes
  → character identity assets
  → stable-diffusion.cpp image generation
  → optional Windows SAPI voice
  → FFmpeg camera motion / captions / audio
  → optional MuseTalk single-speaker pass
  → full decode verification
  → atomic MP4 commit
```

Engine 以原子方式寫入 `status.json`，控制要求放入 `control.json`。GPU 工作透過跨程序檔案鎖序列化；取消會終止真正的子程序，而不是只讓 UI 停止輪詢。

## 8. RTX 3050 4GB 的速度／品質路徑

- Agent 模型常駐並設定閒置卸載，不在每階段重載；
- 448×768／768×448、batch 1；
- 一個 GPU worker，CPU／FFmpeg 工作可在安全範圍內並行；
- Flash Attention、VAE tiling、CPU offload；
- 3GB 模型 VRAM 預算並保留系統空間；
- 角色資產、下載、AI 圖片與 Agent 計畫跨工作重用；
- `balanced` 預設保留 DPM++ 與完整導演驗收，不以文字卡或極低步數假裝加速。

此路徑優先避免 OOM。0.6.0 不宣稱已在 4GB 卡上穩定執行大型逐幀 I2V；目前成片核心是角色一致的 AI 關鍵畫面、鏡頭運動、配音、字幕、音效與可選單人對嘴。

## 9. 模型安裝安全

模型 manifest 固定來源、大小、SHA-256、授權與啟用規則。安裝流程包含 HTTPS redirect gate、Range 續傳、磁碟預檢、安全 ZIP 展開、同磁碟 staging、完整性驗證與原子切換。Render 前會再次驗證啟用 pack，避免 Runtime 或權重被替換後執行。

## 10. 簽章式自動更新

### Build side

`PUBLISH_UPDATE.bat` 只負責版本同步、來源驗證、commit 與 tag。GitHub Actions 在乾淨的 Windows runner 上完成：

```text
npm ci → TypeScript → Vitest → Engine tests/build → Tauri NSIS → updater signature → GitHub Release/latest.json
```

私鑰只存在 `%USERPROFILE%\.evolabs\updater` 的發佈者備份與 GitHub Actions Secret。它不會進入 git、Tauri resource 或前端 bundle。

### Client side

App 啟動後讀取 bundled `update-channel.json`，使用 HTTPS endpoint 與公開金鑰建立 updater，並保存一次 pending update。使用者按「更新並重啟」後，Tauri 下載、驗證簽章並以 Windows `passive` 模式安裝。

Tauri updater 簽章與 Windows Authenticode 不同。前者保護 Evolabs 內部更新鏈；後者影響 Windows 發行者身分與 SmartScreen 信譽。

## 11. 發行邊界

- 第一個含公開金鑰與 endpoint 的 0.6.0 仍需完成一次完整安裝；`SETUP_AUTO_UPDATE.bat` 會等待雲端建置、下載安裝器並詢問是否立即啟動，不需要使用者自己尋找 Release。
- 更換或遺失私鑰後，已安裝舊公開金鑰的使用者無法接受新簽章；因此必須安全備份。
- GitHub Releases 無登入更新要求 repository 公開；私有 repository 需要另建帶授權的 update service，本版一鍵腳本不假裝處理這個條件。
- 目前交付的是可由既有 GitHub Actions Windows runner 編譯、簽署和發佈的來源包；非 Windows 開發環境不冒充已完成本機 NSIS 編譯。
