import type { ChangeEvent } from 'react';
import { Bell, CheckCircle2, Download, FileText, FolderOpen, Gauge, RotateCcw, ShieldCheck } from 'lucide-react';
import type { AppUpdateInfo, EvolabsProject, HardwareProfile, StorageOverview, VideoProviderStatus } from '../types';
import StoragePanel from './StoragePanel';
import { SectionHeader, StatusPill } from './ui';

interface SettingsViewProps {
  project: EvolabsProject;
  hardware: HardwareProfile;
  update: AppUpdateInfo;
  videoProvider: VideoProviderStatus;
  checkingUpdate: boolean;
  installingUpdate: boolean;
  storageOverview: StorageOverview | null;
  resourceBusy: string;
  onSettingChange: <K extends keyof EvolabsProject['settings']>(key: K, value: EvolabsProject['settings'][K]) => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenModels: () => void;
  onRefreshStorage: () => void;
  onRemoveStorageItem: (itemId: string, confirmation: string) => Promise<void>;
  onRemoveOldModelVersions: () => Promise<void>;
  onRevealStorageItem: (itemId: string) => void;
  onResetProject: () => void;
}

function Toggle({ checked, label, description, onChange, disabled = false }: { checked: boolean; label: string; description: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle-row${disabled ? ' is-disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input className="toggle-row__input" type="checkbox" checked={checked} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}

export default function SettingsView({
  project,
  hardware,
  update,
  videoProvider,
  checkingUpdate,
  installingUpdate,
  storageOverview,
  resourceBusy,
  onSettingChange,
  onCheckUpdate,
  onInstallUpdate,
  onOpenModels,
  onRefreshStorage,
  onRemoveStorageItem,
  onRemoveOldModelVersions,
  onRevealStorageItem,
  onResetProject,
}: SettingsViewProps) {
  return (
    <div className="page page--settings">
      <SectionHeader
        eyebrow="應用程式設定"
        title="應用程式設定"
        description="設定依照一般、生成與品質、效能、更新與診斷分類。每一項都說明實際效果與限制。"
      />

      <div className="settings-layout">
        <main className="settings-main">
          <section className="panel settings-section">
            <div className="settings-section__header"><FileText size={19} /><div><span className="eyebrow">基本偏好</span><h2>一般</h2></div></div>
            <div className="form-grid form-grid--two">
              <label className="field">
                <span>介面語言</span>
                <select value="zh-TW" disabled><option value="zh-TW">繁體中文</option></select>
                <small>目前版本提供繁體中文介面。</small>
              </label>
              <label className="field">
                <span>介面主題</span>
                <select value="dark" disabled><option value="dark">深色</option></select>
                <small>維持克制、低干擾的製作環境。</small>
              </label>
            </div>
            <Toggle checked={project.settings.autoSave !== false} label="自動儲存專案" description="內容變更後在本機安全儲存；失敗時會明確顯示。" onChange={(value) => onSettingChange('autoSave', value)} />
            <Toggle checked={project.settings.reducedMotion === true} label="減少介面動畫" description="降低不必要的過場與動態效果。" onChange={(value) => onSettingChange('reducedMotion', value)} />
          </section>

          <section className="panel settings-section">
            <div className="settings-section__header"><ShieldCheck size={19} /><div><span className="eyebrow">生成與品質</span><h2>生成與品質</h2></div></div>
            <div className="form-grid form-grid--two">
              <label className="field">
                <span>預設生成模式</span>
                <select value={project.settings.visualMode ?? 'ai-video'} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('visualMode', event.target.value as EvolabsProject['settings']['visualMode'])}>
                  <option value="ai-video">AI 影片</option>
                  <option value="motion-comic">動態漫畫</option>
                </select>
                <small>動態漫畫會以獨立模式標示，不會與影片模型輸出混淆。</small>
              </label>
              <label className="field">
                <span>影片品質</span>
                <select value={project.settings.quality} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('quality', event.target.value as EvolabsProject['settings']['quality'])}>
                  <option value="speed">快速預覽</option>
                  <option value="balanced">平衡</option>
                  <option value="cinema">高品質輸出</option>
                </select>
              </label>
              <label className="field">
                <span>不合格鏡頭重試上限</span>
                <select value={project.settings.maxShotRetries ?? 3} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('maxShotRetries', Number(event.target.value))}>
                  <option value={1}>1 次</option>
                  <option value={2}>2 次</option>
                  <option value={3}>3 次</option>
                  <option value={4}>4 次</option>
                  <option value={5}>5 次</option>
                </select>
              </label>
              <label className="field">
                <span>目標影片長度</span>
                <select value={project.settings.targetSeconds} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('targetSeconds', Number(event.target.value))}>
                  {[30, 45, 60, 90, 120, 180].map((seconds) => <option value={seconds} key={seconds}>{seconds} 秒</option>)}
                </select>
              </label>
            </div>
            <Toggle checked={project.settings.captions} label="字幕" description="將對白燒錄至最終影片。" onChange={(value) => onSettingChange('captions', value)} />
            <Toggle checked={project.settings.strictCharacterSafety !== false} label="角色與內容安全限制" description="強制年齡、完整服裝、正常人體與角色一致性提示。" onChange={(value) => onSettingChange('strictCharacterSafety', value)} />
            <Toggle checked label="逐鏡人工核准" description="AI 影片每個鏡頭必須經你確認，才會進入最終成片。此安全條件不可關閉。" onChange={() => undefined} disabled />
            <Toggle checked={project.settings.visualMode !== 'ai-video' && project.settings.lipSync === true} label="口型同步" description={project.settings.visualMode === 'ai-video' ? 'AI 影片模式尚未提供經驗證的本機口型同步，因此固定關閉。' : '動態漫畫模式可使用已安裝的口型同步元件。'} onChange={(value) => onSettingChange('lipSync', value)} disabled={project.settings.visualMode === 'ai-video'} />
          </section>

          <section className="panel settings-section">
            <div className="settings-section__header"><Gauge size={19} /><div><span className="eyebrow">硬體與效能</span><h2>效能</h2></div></div>
            <div className="form-grid form-grid--two">
              <label className="field">
                <span>影片工作排程</span>
                <select value="single" disabled><option value="single">單一 GPU 工作</option></select>
                <small>低顯存裝置固定一次只執行一個影片鏡頭。</small>
              </label>
              <label className="field">
                <span>硬體設定檔</span>
                <select value={hardware.profile} disabled><option value={hardware.profile}>{hardware.profile === 'rtx3050-4gb' ? 'RTX 3050 4 GB 低顯存' : hardware.profile}</option></select>
              </label>
            </div>
            <div className="hardware-summary">
              <div><span>GPU</span><strong>{hardware.gpu}</strong></div>
              <div><span>顯示記憶體</span><strong>{hardware.vramMb ? `${(hardware.vramMb / 1024).toFixed(1)} GB` : '未偵測'}</strong></div>
              <div><span>系統記憶體</span><strong>{hardware.ramGb ? `${hardware.ramGb} GB` : '未偵測'}</strong></div>
              <div><span>影片模型服務</span><strong>{videoProvider.available ? videoProvider.workflowName ?? '已連線' : '尚未完成設定'}</strong></div>
            </div>
            <p className="form-note">RTX 3050 4 GB 適合低顯存實驗工作流。若模型或硬體無法完成工作，系統會停止並顯示原因。</p>
          </section>

          <StoragePanel
            overview={storageOverview}
            busy={resourceBusy}
            onRefresh={onRefreshStorage}
            onRemove={onRemoveStorageItem}
            onRemoveOldVersions={onRemoveOldModelVersions}
            onReveal={onRevealStorageItem}
            onOpenModels={onOpenModels}
          />
        </main>

        <aside className="settings-sidebar">
          <section className="panel update-card">
            <div className="settings-section__header"><Download size={19} /><div><span className="eyebrow">軟體更新</span><h2>更新</h2></div></div>
            <div className="version-line">
              <div><strong>Evolabs {update.currentVersion || '0.8.0-beta.2'}</strong><small>{update.message}</small></div>
              <StatusPill tone={update.available ? 'warning' : update.configured ? 'good' : 'neutral'}>{update.available ? '有新版本' : update.configured ? '已設定' : '未設定'}</StatusPill>
            </div>
            {update.notes && <p className="update-notes">{update.notes}</p>}
            <div className="button-stack">
              <button className="button button--secondary button--full" type="button" disabled={checkingUpdate} onClick={onCheckUpdate}>
                {checkingUpdate ? <span className="spinner" /> : <CheckCircle2 size={16} />} {checkingUpdate ? '檢查中' : '檢查更新'}
              </button>
              {update.available && (
                <button className="button button--primary button--full" type="button" disabled={installingUpdate} onClick={onInstallUpdate}>
                  {installingUpdate ? <span className="spinner" /> : <Download size={16} />} {installingUpdate ? '安裝中' : '更新並重新啟動'}
                </button>
              )}
            </div>
          </section>

          <section className="panel diagnostics-card">
            <div className="settings-section__header"><Bell size={19} /><div><span className="eyebrow">系統診斷</span><h2>狀態與診斷</h2></div></div>
            <dl>
              <div><dt>本機 AI 執行環境</dt><dd>{hardware.runtimeReady ? '已通過本機檢查' : '尚未完成檢查'}</dd></div>
              <div><dt>影片模型服務</dt><dd>{videoProvider.available ? '已連線並通過驗證' : videoProvider.error ?? '尚未完成設定'}</dd></div>
              <div><dt>影音編碼與生成引擎</dt><dd>{hardware.runtimeReady ? '已通過檢查' : '尚未完成檢查'}</dd></div>
            </dl>
            <button className="button button--secondary button--full" type="button" onClick={onOpenModels}><FolderOpen size={16} /> 開啟模型與執行環境</button>
          </section>

          <section className="panel danger-card">
            <div className="settings-section__header"><RotateCcw size={19} /><div><span className="eyebrow">專案管理</span><h2>專案重設</h2></div></div>
            <p>清除目前編劇交付、角色、場景、分鏡與對話，建立新的空白專案。</p>
            <button className="button button--danger button--full" type="button" onClick={onResetProject}><RotateCcw size={16} /> 建立新專案</button>
          </section>
        </aside>
      </div>
    </div>
  );
}
