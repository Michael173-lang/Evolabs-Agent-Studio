import { Check, ChevronDown, Download, RefreshCw, Settings } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { AppUpdateInfo, EvolabsProject, HardwareProfile, QualityPreset } from '../types';
import { SectionHeading, StatusPill } from './ui';

interface SettingsViewProps {
  project: EvolabsProject;
  hardware: HardwareProfile;
  saveState: 'saved' | 'saving' | 'error';
  updateInfo: AppUpdateInfo | null;
  onSettingChange: <K extends keyof EvolabsProject['settings']>(key: K, value: EvolabsProject['settings'][K]) => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}

export default function SettingsView({
  project,
  hardware,
  saveState,
  updateInfo,
  onSettingChange,
  onCheckUpdate,
  onInstallUpdate,
}: SettingsViewProps) {
  return (
    <div className="studio-page settings-page">
      <SectionHeading
        eyebrow="STUDIO SETTINGS"
        title="應用程式設定"
        detail="設定以清楚、可回復為原則；不再用隱藏開關改變整個生成流程。"
        action={<StatusPill tone={saveState === 'saved' ? 'good' : saveState === 'saving' ? 'working' : 'bad'}>{saveState === 'saved' ? '已儲存' : saveState === 'saving' ? '儲存中' : '儲存失敗'}</StatusPill>}
      />

      <div className="settings-layout">
        <section className="settings-card">
          <header><Settings size={18} /><div><strong>預設輸出</strong><small>每個專案仍可在開始頁調整。</small></div></header>
          <div className="settings-form-grid">
            <label><span>品質</span><select value={project.settings.quality} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('quality', event.target.value as QualityPreset)}><option value="speed">快速 · 4GB 安全</option><option value="balanced">平衡 · 建議</option><option value="cinema">精緻 · 較慢</option></select><ChevronDown size={14} /></label>
            <label><span>畫面來源</span><select value={project.settings.visualMode || 'ai-images'} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('visualMode', event.target.value as EvolabsProject['settings']['visualMode'])}><option value="ai-images">AI 畫面</option><option value="cards">快速分鏡卡</option></select><ChevronDown size={14} /></label>
            <label><span>圖片執行器</span><select value={project.settings.imageProvider || 'auto'} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('imageProvider', event.target.value as EvolabsProject['settings']['imageProvider'])}><option value="auto">自動選擇</option><option value="sd-cli">stable-diffusion.cpp</option><option value="automatic1111">Automatic1111 API</option></select><ChevronDown size={14} /></label>
          </div>
          <div className="toggle-list">
            <label><input type="checkbox" checked={project.settings.captions} onChange={(event: ChangeEvent<HTMLInputElement>) => onSettingChange('captions', event.target.checked)} /><span>{project.settings.captions ? <Check size={13} /> : null}</span><p><strong>自動字幕</strong><small>依台詞與配音時間寫入成片。</small></p></label>
            <label><input type="checkbox" checked={project.settings.keepCharacterIdentity !== false} onChange={(event: ChangeEvent<HTMLInputElement>) => onSettingChange('keepCharacterIdentity', event.target.checked)} /><span>{project.settings.keepCharacterIdentity !== false ? <Check size={13} /> : null}</span><p><strong>角色身份一致性</strong><small>生成角色身份資產並跨鏡頭重用。</small></p></label>
            <label><input type="checkbox" checked={project.settings.lipSync === true} onChange={(event: ChangeEvent<HTMLInputElement>) => onSettingChange('lipSync', event.target.checked)} /><span>{project.settings.lipSync ? <Check size={13} /> : null}</span><p><strong>單人對嘴</strong><small>僅在本機 MuseTalk 健康檢查通過時可執行。</small></p></label>
          </div>
        </section>

        <section className="settings-card">
          <header><Download size={18} /><div><strong>自動更新</strong><small>安裝包與程式內更新都會驗證 Tauri updater 簽章。</small></div><StatusPill tone={updateInfo?.configured ? 'good' : 'warning'}>{updateInfo?.configured ? '已綁定' : '待綁定'}</StatusPill></header>
          <div className="update-status-box">
            <span><strong>{updateInfo?.available ? `可更新至 ${updateInfo.version}` : `Evolabs ${updateInfo?.currentVersion || '0.7.0'}`}</strong><small>{updateInfo?.message || '尚未檢查更新。'}</small></span>
            <div><button type="button" className="secondary-action" onClick={onCheckUpdate}><RefreshCw size={14} /> 檢查更新</button>{updateInfo?.available && <button type="button" className="primary-action" onClick={onInstallUpdate}>更新並重啟</button>}</div>
          </div>
        </section>

        <section className="settings-card system-summary-card">
          <header><div><strong>系統摘要</strong><small>供故障排查，不使用模糊的「應該可以」。</small></div></header>
          <dl>
            <div><dt>GPU</dt><dd>{hardware.gpu}</dd></div>
            <div><dt>VRAM</dt><dd>{hardware.vramMb ? `${(hardware.vramMb / 1024).toFixed(1)} GB` : '未偵測'}</dd></div>
            <div><dt>CPU／RAM</dt><dd>{hardware.cpu} · {hardware.ramGb} GB</dd></div>
            <div><dt>Engine</dt><dd>{hardware.runtimeReady ? hardware.runtimeVersion || '就緒' : '未就緒'}</dd></div>
            <div><dt>AI Provider</dt><dd>{hardware.aiProvider || '尚未就緒'}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
