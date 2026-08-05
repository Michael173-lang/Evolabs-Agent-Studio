# Evolabs Agent Studio 0.8 架構

## 1. 可信執行原則

Evolabs 0.8 將「看起來像 AI」改為「每一步都可證明由模型執行」。核心規則如下：

- 對話區只能包含使用者訊息與模型實際回覆；
- 系統活動、錯誤、重試與驗證紀錄獨立顯示；
- 本機 AI 執行環境離線時禁止啟動 Agent；
- 模型失敗時不得用規則式成果冒充 AI；
- AI 影片模式必須取得真正影片輸出；
- 靜態圖片與 FFmpeg 運鏡只能存在於明確標示的動態漫畫模式；
- 所有鏡頭在進入成片前都必須通過檔案檢查與使用者核准。

## 2. Agent 任務契約

每位 Agent 在執行前必須回傳任務確認：

```json
{
  "understoodTask": true,
  "objective": "目前要完成的具體工作",
  "inputsReceived": ["劇本", "角色聖經", "影片模型能力"],
  "constraints": ["角色年齡與服裝不可漂移"],
  "missingInformation": []
}
```

`understoodTask` 為 `false` 或 `missingInformation` 非空時，工作會進入受阻狀態，不得產生正式交付物。

每個階段使用獨立的輸出合約與嚴格 normalizer。模型回覆必須通過結構、大小、ID、引用關係與業務規則驗證，才能寫入專案。

## 3. 真實對話與修改提案

使用者可以與單一 Agent 或製作會議交流。模型回答會保存執行證據，但不保存或顯示隱藏思考過程。

Agent 對專案的修改不是自由寫入，而是建立受限制的提案：

```text
模型回覆
  → allowlist 操作解析
  → 修改預覽
  → 使用者套用或拒絕
  → 寫入共享專案記憶
```

可允許的操作包括角色屬性、服裝、場景、對白、分鏡與鏡頭生成要求。未知路徑、任意程式碼或未授權資料不得套用。

## 4. 共享專案記憶

`ProductionBible` 與專案級角色、場景、鏡頭資料共同構成製作真相來源。所有 Agent 取得：

- 原始劇本與已批准改稿；
- 使用者最新指令；
- 角色與場景鎖定項；
- 前序 Agent 交付物；
- 指定影片工作流能力；
- 目前退件原因與修正輪次。

導演驗收不只是分數。導演可以將成果退回指定 Agent，系統限制最大修正輪次，避免無限循環。

## 5. Agent 模型服務

Rust `agent_models` 模組負責：

- 只允許 loopback 的 OpenAI 相容端點；
- 讀取實際 `/v1/models`；
- 驗證所選模型存在；
- 執行結構化測試；
- 呼叫 `run_agent_stage_v3` 與 `run_agent_conversation`；
- 產生 request ID、模型、延遲、Token 與驗證證據；
- 拒絕不存在的模型、無效 JSON、資料缺失與不合約成果。

Runtime Manager 可安裝／啟動 LM Studio headless 元件與指定 Qwen 模型，但 UI 只有在實際健康檢查成功後才標示可用。

## 6. 真正影片模型服務

0.8 的 AI 影片路徑以本機 ComfyUI API 工作流為第一個 Provider 實作。Rust `video_providers` 模組負責設定與驗證，Python `ComfyUiVideoProvider` 負責排程與取得影片。

工作流必須包含：

```text
{{EVOLABS_PROMPT}}
{{EVOLABS_NEGATIVE_PROMPT}}
{{EVOLABS_SEED}}
{{EVOLABS_FRAMES}}
{{EVOLABS_FPS}}
```

系統會檢查：

- endpoint 為 loopback；
- `/object_info` 可用；
- API workflow JSON 可解析；
- 必要節點已註冊；
- 必要參數綁定存在；
- 具有影片輸出能力；
- 產物 MIME／副檔名為支援的影片格式。

只有 PNG／JPG 輸出的工作流會以 `COMFYUI_VIDEO_OUTPUT_REQUIRED` 拒絕。

## 7. 逐鏡生成與審核

```text
角色／場景／分鏡規格
  → 建立 Shot request
  → ComfyUI 真正影片生成
  → 下載影片產物
  → 解碼、時長、黑畫面、凍結畫面檢查
  → 等待使用者審核
  → 核准或附註退回
  → 限次重新生成
```

每個 Shot 保存 Provider、工作流、Seed、幀數、FPS、輸出路徑、檢查結果、審核狀態與重試次數。未核准鏡頭不能進入最終合成。

## 8. 人物與內容安全

生成要求固定：

- 明確年齡、身份與完整服裝；
- 單一正常頭部與兩隻眼睛；
- 正常四肢與手部；
- 禁止裸露、額外肢體、額外臉部與角色重複；
- 禁止年齡、服裝與身份漂移；
- 要求真正時間運動，而非靜態圖片平移。

目前 Beta 的自動檢查以影片檔確定性檢查為主；人物語意品質由逐鏡人工檢查清單保障。未來可新增經驗證的視覺品質分類器，但未實作前不得宣稱已自動識別全部畸形或裸露問題。

## 9. 動態漫畫隔離

動態漫畫保留舊版靜態圖片模型、字幕、配音與 FFmpeg 運鏡能力，但：

- 使用獨立 `motion-comic` 模式；
- UI、任務狀態與成片 metadata 都明確標示不是 AI 影片；
- 不會在影片模型失敗時自動切換；
- 舊版 `ai-images` 專案遷移為動態漫畫。

## 10. UI 狀態模型

產品介面分為：

1. 開始製作；
2. 製作工作區；
3. 模型與本機執行環境；
4. 應用程式設定。

製作工作區再分離：

- AI 對話；
- 系統活動；
- 交付物；
- 鏡頭與人工審核。

所有進度由真實任務狀態計算，不使用固定計時器或假 99%。CSS 強制橫向書寫、可縮小內容、正確換行與 980／720 px 響應式斷點。

## 11. 儲存、復原與稽核

專案保存：

- 真實對話與模型證據；
- 系統活動；
- Agent 任務確認；
- 修改提案及套用狀態；
- 影片工作與逐鏡審核；
- Production Bible 與版本遷移資訊。

舊專案中沒有有效模型證據的預寫 Agent 訊息在遷移時會移除；使用者訊息與可驗證資料保留。

## 12. 發行與 Beta 邊界

Windows CI 依序執行：

```text
版本同步
→ npm ci
→ 來源驗證
→ TypeScript
→ Vitest
→ 前端正式建置
→ Rust/Tauri 測試
→ Engine 測試與打包
→ 圖示生成
→ NSIS
→ updater 簽章
→ GitHub Prerelease + latest.json
```

0.8.0-beta.2 只可發布為 Prerelease。升為穩定版前，必須在 Windows 實機以至少一套真正影片工作流完成多鏡頭端到端生成與人工驗收；RTX 3050 4 GB 只可標示為實驗性相容。
