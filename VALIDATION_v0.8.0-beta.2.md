# Evolabs v0.8.0-beta.2 快速驗證紀錄

## 已完成

- 發行版本一致性：`package.json`、`package-lock.json`、Tauri、Cargo、Engine 與協定版本均為 `0.8.0-beta.2`。
- 發行來源檢查：通過 `scripts/validate-source-release.py`。
- TypeScript：主要應用程式來源通過嚴格型別快速檢查。
- Python 影片服務測試：`engine/tests/test_video_providers.py` 共 6 項通過。
- Python 語法編譯：版本同步、來源驗證及影片服務模組通過。
- CSS 結構：大括號數量一致。
- Git 差異檢查：未發現衝突標記或空白錯誤。
- Windows 腳本格式：BAT 使用 CRLF 且不含 BOM；PowerShell 腳本使用 CRLF 與 UTF-8 BOM。

## 本次快速檢查未執行

目前驗證環境沒有 Windows Rust/MSVC 工具鏈，且 npm 套件來源無法完整取得，因此未在此環境重跑完整 Vitest、Rust/Tauri、Engine 可執行檔與 NSIS 安裝程式建置。

完整 Windows 驗證由來源包內的 `1_BUILD_AND_TEST.bat` 執行；只有該步驟成功後，才應使用 `2_PUBLISH_RELEASE.bat` 發布。

## 重要邊界

- Evolabs 已能自動管理 ComfyUI 執行環境，但真正的影片模型檔案與相容工作流仍須存在並通過影片輸出驗證。
- RTX 3050 Laptop 4 GB 對真正影片模型維持實驗性相容，實際速度及可用性取決於模型、量化、工作流、解析度與幀數。
- 儲存清理操作不可復原；Evolabs 僅允許刪除已掃描且位於受管理目錄內的項目。
