import { BrainCircuit, Check, Cpu, Download, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import type { AgentModelCatalog } from '../lib/studioBridge';
import type { HardwareProfile, ModelInstallSnapshot } from '../types';
import { ProgressBar, SectionHeading, StatusPill } from './ui';

interface ModelsViewProps {
  hardware: HardwareProfile;
  catalog: AgentModelCatalog;
  selectedModelId: string;
  licenseAccepted: boolean;
  install: ModelInstallSnapshot | null;
  repairing: boolean;
  runtimeProgress: number;
  onSelectModel: (modelId: string) => void;
  onAcceptLicense: (accepted: boolean) => void;
  onInstallVisual: (packId: string) => void;
  onRepairRuntime: () => void;
  onRefresh: () => void;
}

function packTone(status: string): 'good' | 'warning' | 'bad' | 'neutral' {
  if (status === 'ready') return 'good';
  if (status === 'invalid') return 'bad';
  if (status === 'missing') return 'warning';
  return 'neutral';
}

export default function ModelsView({
  hardware,
  catalog,
  selectedModelId,
  licenseAccepted,
  install,
  repairing,
  runtimeProgress,
  onSelectModel,
  onAcceptLicense,
  onInstallVisual,
  onRepairRuntime,
  onRefresh,
}: ModelsViewProps) {
  const [manualModel, setManualModel] = useState('');
  const installRunning = Boolean(install && ['queued', 'running'].includes(install.state));
  const packs = hardware.modelPacks ?? [];
  return (
    <div className="studio-page models-page">
      <SectionHeading
        eyebrow="MODEL MANAGEMENT"
        title="模型與 Runtime"
        detail="Evolabs 只列出這台電腦實際載入的 Agent 模型；選擇不存在的模型時會明確阻止送出，不再靜默誤用其他模型。"
        action={<button type="button" className="secondary-action" onClick={onRefresh}><RefreshCw size={14} /> 重新整理</button>}
      />

      <div className="models-layout">
        <section className="model-section">
          <header><div><BrainCircuit size={18} /><span><strong>Agent 文字模型</strong><small>{catalog.message}</small></span></div><StatusPill tone={catalog.available ? 'good' : 'warning'}>{catalog.available ? `${catalog.models.length} 個已載入` : '未連線'}</StatusPill></header>
          <div className="agent-model-list">
            <label className={`agent-model-row ${selectedModelId === 'auto' ? 'selected' : ''}`}>
              <input type="radio" name="agent-model" checked={selectedModelId === 'auto'} onChange={() => onSelectModel('auto')} />
              <span className="model-radio" />
              <span><strong>自動選擇</strong><small>優先使用 Evolabs 建議模型，再依序選擇已載入的 Qwen3 或第一個可用模型。</small></span>
              <StatusPill tone="good">建議</StatusPill>
            </label>
            {catalog.models.map((model) => (
              <label key={model.id} className={`agent-model-row ${selectedModelId === model.id ? 'selected' : ''}`}>
                <input type="radio" name="agent-model" checked={selectedModelId === model.id} onChange={() => onSelectModel(model.id)} />
                <span className="model-radio" />
                <span><strong>{model.name}</strong><small>{model.id}{model.family ? ` · ${model.family}` : ''}{model.contextLength ? ` · ${model.contextLength.toLocaleString()} context` : ''}</small></span>
                {model.recommended ? <StatusPill tone="good">建議</StatusPill> : <StatusPill tone="neutral">已載入</StatusPill>}
              </label>
            ))}
            {!catalog.models.length && <div className="empty-model-list">尚未偵測到已載入模型。按「修復 Agent Runtime」可準備預設 Qwen3 4B；其他模型可由 LM Studio 載入後回到此頁重新整理。</div>}
          </div>
          <div className="manual-model-box">
            <label><span>手動指定已載入模型 ID</span><input value={manualModel} onChange={(event: ChangeEvent<HTMLInputElement>) => setManualModel(event.target.value)} placeholder="例如：local-model-name" /></label>
            <button type="button" className="secondary-action" disabled={!manualModel.trim()} onClick={() => { onSelectModel(manualModel.trim()); setManualModel(''); }}>使用此 ID</button>
          </div>
          <p className="section-note">手動 ID 仍會由後端向 <code>/v1/models</code> 驗證；不存在或未載入的模型不會被呼叫。</p>
        </section>

        <section className="model-section runtime-section">
          <header><div><Cpu size={18} /><span><strong>本機 Agent Runtime</strong><small>{hardware.gpu} · {hardware.vramMb ? `${Math.round(hardware.vramMb / 1024)} GB VRAM` : hardware.cpu}</small></span></div><StatusPill tone={catalog.available ? 'good' : repairing ? 'working' : 'warning'}>{catalog.available ? '正常' : repairing ? '修復中' : '需要修復'}</StatusPill></header>
          {repairing && <div className="runtime-repair-progress"><div><span>正在準備 Runtime</span><strong>{Math.round(runtimeProgress)}%</strong></div><ProgressBar value={runtimeProgress} /></div>}
          <button type="button" className="secondary-action full" disabled={repairing} onClick={onRepairRuntime}>{repairing ? <><LoaderCircle size={15} className="spin" /> 正在修復</> : <><RefreshCw size={15} /> 修復 Agent Runtime</>}</button>
        </section>

        <section className="model-section visual-model-section">
          <header><div><Download size={18} /><span><strong>視覺模型包</strong><small>畫面模型與編劇模型分開管理，可依作品風格選擇。</small></span></div><StatusPill tone={hardware.aiReady ? 'good' : 'warning'}>{hardware.aiReady ? '可生成 AI 畫面' : '尚未完整準備'}</StatusPill></header>
          <div className="visual-pack-list">
            {packs.map((pack) => (
              <article key={pack.id}>
                <span className={`pack-state state-${pack.status}`}>{pack.status === 'ready' ? <Check size={15} /> : <Download size={15} />}</span>
                <div><strong>{pack.name}</strong><small>{pack.message || pack.version || pack.id}</small></div>
                <StatusPill tone={packTone(pack.status)}>{pack.status === 'ready' ? '已就緒' : pack.status === 'missing' ? '未安裝' : pack.status === 'invalid' ? '需修復' : '不支援'}</StatusPill>
                {pack.status !== 'ready' && pack.status !== 'unavailable' && <button type="button" disabled={!licenseAccepted || installRunning} onClick={() => onInstallVisual(pack.id)}>{installRunning && install?.packId === pack.id ? '安裝中' : '安裝'}</button>}
              </article>
            ))}
            {!packs.length && <div className="empty-model-list">本機引擎尚未回傳模型包清單。</div>}
          </div>
          <label className="license-check">
            <input type="checkbox" checked={licenseAccepted} onChange={(event: ChangeEvent<HTMLInputElement>) => onAcceptLicense(event.target.checked)} />
            <span>{licenseAccepted ? <Check size={13} /> : null}</span>
            <p><strong>我已閱讀並接受視覺模型授權</strong><small>CreativeML Open RAIL-M；只需在這台電腦確認一次。</small></p>
            <ShieldCheck size={16} />
          </label>
          {install && (
            <div className={`model-install-status state-${install.state}`}>
              <div><span>{install.state === 'running' ? <LoaderCircle size={15} className="spin" /> : install.state === 'completed' ? <Check size={15} /> : <Download size={15} />}</span><p><strong>{install.packName || install.packId || '模型安裝'}</strong><small>{install.error || install.message || install.state}</small></p><em>{Math.round(install.progress)}%</em></div>
              <ProgressBar value={install.progress} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
