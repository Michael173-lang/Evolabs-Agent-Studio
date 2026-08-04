# 第三方元件說明

Evolabs 原始工程使用下列主要第三方元件；正式散布前仍應由發行者完成授權與簽署審查。

| 元件 | 用途 | 授權提示 |
|---|---|---|
| Tauri、React、Vite | Windows App 與介面 | 依各套件隨附授權 |
| Pillow | 分鏡卡圖像處理 | HPND |
| imageio-ffmpeg | 取得可封裝的 FFmpeg 執行檔 | BSD-2-Clause（Python 包裝器） |
| FFmpeg／libx264 | H.264／AAC 編碼與影片驗證 | 以實際封裝 binary 的 `ffmpeg -L` 為準；可能觸發 GPL 義務 |
| Noto Sans TC | 繁體中文介面字型 | SIL Open Font License 1.1 |
| stable-diffusion.cpp | 本機 CUDA 圖片推論 | MIT；由官方 release 下載並驗證 |
| AbyssOrangeMix 3 | 動漫 SD1.5 權重 | CreativeML Open RAIL-M；安裝前明確同意 |
| Realistic Vision V5.1 | 寫實 SD1.5 權重 | CreativeML Open RAIL-M；安裝前明確同意 |
| Stability AI SD VAE FT-MSE | 寫實模型解碼 | MIT |
| IP-Adapter／CLIP Vision | 單角色參考圖條件 | Apache-2.0 |
| MuseTalk 1.5（選配、自備） | 單人對嘴 | 上游程式碼 MIT；模型與 Whisper、VAE、DWPose、臉部分割等依賴須由使用者依各來源條款自行安裝，Evolabs 不封裝或自動下載 |

`scripts/build-engine.ps1` 會把實際 FFmpeg binary 回報的授權文字寫入安裝資源 `manifests/notices/ffmpeg-license.txt`，並在缺少該文字時阻止發行建置。模型權重不會隨 App／NSIS 封裝；使用者在 App 內閱讀授權後，才從 manifest 固定的上游網址下載與驗證。
