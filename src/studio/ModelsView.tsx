import { AlertTriangle, Check, FileJson2, HardDrive, RefreshCw, ServerCog, Trash2, Video } from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import type {
  AgentModelCatalog,
  AgentModelTestResult,
  HardwareProfile,
  RuntimeSetupSnapshot,
  VideoProviderStatus,
} from '../types';
import { EmptyState, ProgressBar, SectionHeader, StatusPill } from './ui';

interface ModelsViewProps {
  catalog: AgentModelCatalog;
  selectedModelId: string;
  modelTest: AgentModelTestResult | null;
  runtimeSetup: RuntimeSetupSnapshot;
  hardware: HardwareProfile;
  videoProvider: VideoProviderStatus;
  refreshing: boolean;
  testingModel: boolean;
  configuringVideo: boolean;
  onRefresh: () => void;
  onSelectModel: (modelId: string) => void;
  onTestModel: () => void;
  onRepairRuntime: () => void;
  onConfigureVideo: (endpoint: string, workflowName: string, workflow: unknown) => Promise<void>;
  onClearVideo: () => Promise<void>;
}


function runtimeStateLabel(state: RuntimeSetupSnapshot['state']): string {
  if (state === 'completed') return '已就緒';
  if (state === 'running') return '準備中';
  if (state === 'failed') return '需要修復';
  return '尚未開始';
}

function runtimeStepStateLabel(state: RuntimeSetupSnapshot['steps'][number]['state']): string {
  if (state === 'done') return '已完成';
  if (state === 'working') return '執行中';
  if (state === 'failed') return '執行失敗';
  return '尚未開始';
}

function compatibilityLabel(status: VideoProviderStatus['compatibility']): string {
  if (status === 'recommended') return '硬體條件良好';
  if (status === 'experimental') return '低顯存實驗路徑';
  if (status === 'unsupported') return '目前硬體不支援';
  return '尚未判定';
}

export default function ModelsView({
  catalog,
  selectedModelId,
  modelTest,
  runtimeSetup,
  hardware,
  videoProvider,
  refreshing,
  testingModel,
  configuringVideo,
  onRefresh,
  onSelectModel,
  onTestModel,
  onRepairRuntime,
  onConfigureVideo,
  onClearVideo,
}: ModelsViewProps) {
  const [endpoint, setEndpoint] = useState(videoProvider.endpoint ?? 'http://127.0.0.1:8188');
  const [workflowName, setWorkflowName] = useState(videoProvider.workflowName ?? 'Evolabs ComfyUI 影片工作流');
  const [workflow, setWorkflow] = useState<unknown>(null);
  const [workflowFileName, setWorkflowFileName] = useState('');
  const [fileError, setFileError] = useState('');

  useEffect(() => {
    setEndpoint(videoProvider.endpoint ?? 'http://127.0.0.1:8188');
    setWorkflowName(videoProvider.workflowName ?? 'Evolabs ComfyUI 影片工作流');
  }, [videoProvider.endpoint, videoProvider.workflowName]);

  const importWorkflow = async (file: File | undefined) => {
    if (!file) return;
    setFileError('');
    try {
      if (file.size > 12 * 1024 * 1024) throw new Error('工作流檔案超過 12 MB。');
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('請匯入 ComfyUI 的 API 格式 JSON。');
      setWorkflow(parsed);
      setWorkflowFileName(file.name);
      if (!workflowName.trim() || workflowName === 'Evolabs ComfyUI 影片工作流') setWorkflowName(file.name.replace(/\.json$/i, ''));
    } catch (error) {
      setWorkflow(null);
      setWorkflowFileName('');
      setFileError(error instanceof Error ? error.message : '工作流檔案無法解析。');
    }
  };

  return (
    <div className="page page--models">
      <SectionHeader
        eyebrow="模型與執行環境"
        title="模型與本機執行環境"
        description="Agent 模型負責理解、討論與規劃；影片模型服務負責逐鏡生成真正的時間序列。兩者分開驗證，任何一方失敗都不會在未告知的情況下改用預寫文案或靜態圖片替代。"
        actions={(
          <button className="button button--secondary" type="button" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={16} /> {refreshing ? '重新整理中' : '重新整理'}
          </button>
        )}
      />

      <div className="models-grid">
        <section className="panel model-section model-section--agent">
          <div className="panel__header">
            <div>
              <span className="eyebrow">Agent 模型</span>
              <h2>Agent 文字模型</h2>
              <p>實際讀取本機 OpenAI 相容服務的已載入模型；選擇不存在的模型會直接停止。</p>
            </div>
            <StatusPill tone={catalog.available ? 'good' : 'danger'}>{catalog.available ? '已連線' : '未連線'}</StatusPill>
          </div>

          {!catalog.available ? (
            <EmptyState
              title="本機 AI 執行環境無法使用"
              description={catalog.message}
              action={<button className="button button--primary" type="button" onClick={onRepairRuntime}><ServerCog size={16} /> 修復本機 AI 執行環境</button>}
            />
          ) : (
            <>
              <div className="model-list" role="radiogroup" aria-label="Agent 模型">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selectedModelId === 'auto'}
                  className={`model-row${selectedModelId === 'auto' ? ' is-selected' : ''}`}
                  onClick={() => onSelectModel('auto')}
                >
                  <span className="model-row__radio" aria-hidden="true" />
                  <span className="model-row__copy">
                    <strong>自動選擇</strong>
                    <small>優先使用 Evolabs 建議模型，再依已載入模型選擇。</small>
                  </span>
                  <StatusPill tone="good">建議</StatusPill>
                </button>
                {catalog.models.map((model) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selectedModelId === model.id}
                    className={`model-row${selectedModelId === model.id ? ' is-selected' : ''}`}
                    key={model.id}
                    onClick={() => onSelectModel(model.id)}
                  >
                    <span className="model-row__radio" aria-hidden="true" />
                    <span className="model-row__copy">
                      <strong>{model.name}</strong>
                      <small className="identifier">{model.id}</small>
                    </span>
                    <span className="model-row__meta">
                      {model.family && <StatusPill>{model.family}</StatusPill>}
                      {model.contextLength && <small>可用上下文 {model.contextLength.toLocaleString()} Token</small>}
                    </span>
                  </button>
                ))}
              </div>
              <div className="model-test">
                <div>
                  <strong>結構化回覆測試</strong>
                  <p>不只檢查 `/v1/models`，還會要求所選模型實際回傳符合契約的 JSON。</p>
                </div>
                <button className="button button--secondary" type="button" disabled={testingModel} onClick={onTestModel}>
                  {testingModel ? <span className="spinner" /> : <Check size={16} />} {testingModel ? '測試中' : '測試模型'}
                </button>
              </div>
              {modelTest && (
                <div className={`inline-alert${modelTest.ok ? ' inline-alert--success' : ''}`}>
                  <Check size={17} />
                  <span>{modelTest.message} · {modelTest.modelId} · {(modelTest.latencyMs / 1000).toFixed(1)} 秒 · {modelTest.requestId}</span>
                </div>
              )}
            </>
          )}
        </section>

        <aside className="models-sidebar">
          <section className="panel runtime-card">
            <div className="panel__header panel__header--compact">
              <div>
                <span className="eyebrow">本機執行環境</span>
                <h2>AI 模型執行環境</h2>
              </div>
              <StatusPill tone={runtimeSetup.state === 'completed' ? 'good' : runtimeSetup.state === 'running' ? 'working' : runtimeSetup.state === 'failed' ? 'danger' : 'neutral'}>
                {runtimeStateLabel(runtimeSetup.state)}
              </StatusPill>
            </div>
            <ProgressBar value={runtimeSetup.progress} />
            <p>{runtimeSetup.message}</p>
            <div className="runtime-steps">
              {runtimeSetup.steps.map((step) => (
                <div key={step.id}>
                  <StatusPill tone={step.state === 'done' ? 'good' : step.state === 'working' ? 'working' : step.state === 'failed' ? 'danger' : 'neutral'}>{runtimeStepStateLabel(step.state)}</StatusPill>
                  <span><strong>{step.title}</strong><small>{step.detail}</small></span>
                </div>
              ))}
            </div>
            <button className="button button--secondary button--full" type="button" onClick={onRepairRuntime}><RefreshCw size={16} /> 修復本機 AI 執行環境</button>
          </section>

          <section className="panel hardware-card">
            <div className="panel__header panel__header--compact">
              <div>
                <span className="eyebrow">硬體資訊</span>
                <h2>目前硬體</h2>
              </div>
            </div>
            <dl>
              <div><dt>GPU</dt><dd>{hardware.gpu}</dd></div>
              <div><dt>顯示記憶體</dt><dd>{hardware.vramMb ? `${(hardware.vramMb / 1024).toFixed(1)} GB` : '未偵測'}</dd></div>
              <div><dt>系統記憶體</dt><dd>{hardware.ramGb ? `${hardware.ramGb} GB` : '未偵測'}</dd></div>
              <div><dt>CPU</dt><dd>{hardware.cpu}</dd></div>
            </dl>
            {hardware.vramMb > 0 && hardware.vramMb <= 6 * 1024 && (
              <div className="inline-alert">
                <AlertTriangle size={17} />
                <span>4–6 GB 顯存只能視為真正影片模型的低顯存實驗路徑。Evolabs 不會改用圖片運鏡冒充成功。</span>
              </div>
            )}
          </section>
        </aside>

        <section className="panel model-section model-section--video">
          <div className="panel__header">
            <div>
              <span className="eyebrow">真正影片生成</span>
              <h2>影片模型服務</h2>
              <p>可匯入不同的本機 ComfyUI API 工作流以切換真正的影片模型。Evolabs 會透過 `/object_info` 驗證節點註冊，並檢查必要參數綁定與影片輸出能力。</p>
            </div>
            <StatusPill tone={videoProvider.available ? 'good' : videoProvider.configured ? 'danger' : 'warning'}>
              {videoProvider.available ? '已連線並通過驗證' : videoProvider.configured ? '驗證失敗' : '尚未完成設定'}
            </StatusPill>
          </div>

          <div className="provider-summary">
            <div className="provider-summary__icon"><Video size={22} /></div>
            <div>
              <strong>{videoProvider.name ?? '本機 ComfyUI 影片模型服務'}</strong>
              <p>{videoProvider.message}</p>
              {videoProvider.error && <p className="error-text">{videoProvider.error}</p>}
            </div>
            <StatusPill tone={videoProvider.compatibility === 'recommended' ? 'good' : videoProvider.compatibility === 'experimental' ? 'warning' : 'neutral'}>
              {compatibilityLabel(videoProvider.compatibility)}
            </StatusPill>
          </div>

          {videoProvider.configured && (
            <div className="provider-details">
              <dl>
                <div><dt>位址</dt><dd className="identifier">{videoProvider.endpoint}</dd></div>
                <div><dt>工作流</dt><dd>{videoProvider.workflowName}</dd></div>
                <div><dt>節點數</dt><dd>{videoProvider.nodeCount}</dd></div>
                <div><dt>模型</dt><dd>{videoProvider.detectedModels.join('、') || '工作流未提供可辨識的模型檔名'}</dd></div>
              </dl>
              <div className="capability-grid">
                <StatusPill tone={videoProvider.capabilities.textToVideo ? 'good' : 'neutral'}>文字轉影片</StatusPill>
                <StatusPill tone={videoProvider.capabilities.imageToVideo ? 'good' : 'neutral'}>參考圖轉影片</StatusPill>
                <StatusPill tone={videoProvider.capabilities.outputVideo ? 'good' : 'danger'}>影片輸出</StatusPill>
                <StatusPill tone={videoProvider.capabilities.seedBinding ? 'good' : 'warning'}>隨機種子綁定</StatusPill>
                <StatusPill tone={videoProvider.capabilities.frameBinding ? 'good' : 'warning'}>影片幀數綁定</StatusPill>
                <StatusPill tone={videoProvider.capabilities.fpsBinding ? 'good' : 'warning'}>幀率綁定</StatusPill>
                <StatusPill tone={videoProvider.capabilities.promptBinding ? 'good' : 'danger'}>提示詞綁定</StatusPill>
                <StatusPill tone={videoProvider.capabilities.negativePromptBinding ? 'good' : 'danger'}>負向提示綁定</StatusPill>
                <StatusPill tone={videoProvider.capabilities.outputPrefixBinding ? 'good' : 'danger'}>輸出名稱綁定</StatusPill>
              </div>
            </div>
          )}

          {videoProvider.capabilities.inputImageBinding && (
            <div className="inline-alert">
              <AlertTriangle size={17} />
              <span>目前工作流使用角色參考圖。每個鏡頭必須只有一名角色，且該角色必須先匯入一張身份參考圖；多人鏡頭會在生成前被阻止。需要多人互動時，請改用支援多人參考的影片工作流。</span>
            </div>
          )}

          <div className="provider-config">
            <label className="field">
              <span>ComfyUI 本機位址</span>
              <input value={endpoint} onChange={(event: ChangeEvent<HTMLInputElement>) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:8188" />
              <small>只接受這台電腦上的 localhost、127.0.0.1 或 ::1。</small>
            </label>
            <label className="field">
              <span>工作流名稱</span>
              <input value={workflowName} onChange={(event: ChangeEvent<HTMLInputElement>) => setWorkflowName(event.target.value)} placeholder="LTX-Video 2B 低顯存 I2V" />
            </label>
            <label className="workflow-import">
              <input type="file" accept="application/json,.json" onChange={(event: ChangeEvent<HTMLInputElement>) => void importWorkflow(event.target.files?.[0])} />
              <FileJson2 size={20} />
              <span>
                <strong>{workflowFileName || '匯入 ComfyUI API 工作流'}</strong>
                <small>{'必須匯入 ComfyUI 的「API 格式」工作流。提示詞、負向提示、隨機種子、幀數與幀率綁定，以及影片輸出節點，全部都是必要條件。此處只驗證連線與工作流結構；真正生成能力會在第一個鏡頭工作中確認。'}</small>
              </span>
            </label>
            {fileError && <p className="form-note form-note--danger">{fileError}</p>}
            <details className="binding-help">
              <summary>工作流可使用的 Evolabs 綁定變數</summary>
              <code>{'{{EVOLABS_PROMPT}}'}</code>
              <code>{'{{EVOLABS_NEGATIVE_PROMPT}}'}</code>
              <code>{'{{EVOLABS_SEED}}'}</code>
              <code>{'{{EVOLABS_WIDTH}} / {{EVOLABS_HEIGHT}}'}</code>
              <code>{'{{EVOLABS_FRAMES}} / {{EVOLABS_FPS}}'}</code>
              <code>{'{{EVOLABS_INPUT_IMAGE}}'}</code>
              <code>{'{{EVOLABS_OUTPUT_PREFIX}}'}</code>
            </details>
            <div className="button-row button-row--end">
              {videoProvider.configured && (
                <button className="button button--danger" type="button" onClick={() => void onClearVideo()}>
                  <Trash2 size={16} /> 清除設定
                </button>
              )}
              <button
                className="button button--primary"
                type="button"
                disabled={!workflow || !endpoint.trim() || !workflowName.trim() || configuringVideo}
                onClick={() => void onConfigureVideo(endpoint, workflowName, workflow)}
              >
                {configuringVideo ? <span className="spinner" /> : <HardDrive size={16} />}
                {configuringVideo ? '正在驗證' : '驗證並儲存'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
