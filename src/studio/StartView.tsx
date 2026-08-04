import { BrainCircuit, ChevronDown, FileText, Play, RefreshCw } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { AgentModelCatalog } from '../lib/studioBridge';
import type { EvolabsProject, HardwareProfile, ProjectMode } from '../types';
import { SectionHeading, StatusPill } from './ui';

interface StartViewProps {
  project: EvolabsProject;
  hardware: HardwareProfile;
  catalog: AgentModelCatalog;
  selectedModelId: string;
  submitting: boolean;
  error?: string;
  onStoryChange: (story: string) => void;
  onSettingChange: <K extends keyof EvolabsProject['settings']>(key: K, value: EvolabsProject['settings'][K]) => void;
  onModelChange: (modelId: string) => void;
  onSubmit: () => void;
  onExample: () => void;
  onReset: () => void;
  onOpenModels: () => void;
}

export default function StartView({
  project,
  hardware,
  catalog,
  selectedModelId,
  submitting,
  error,
  onStoryChange,
  onSettingChange,
  onModelChange,
  onSubmit,
  onExample,
  onReset,
  onOpenModels,
}: StartViewProps) {
  const storyLength = project.story.trim().length;
  const ready = storyLength >= 4 && !submitting;
  const selectedModel = selectedModelId === 'auto'
    ? catalog.selectedModel || 'Evolabs 自動選擇'
    : selectedModelId;
  return (
    <div className="studio-page studio-start-page">
      <SectionHeading
        eyebrow="NEW PRODUCTION"
        title="把劇本交給編劇"
        detail="先取得一份看得見、可驗證的編劇分析，再決定是否交給完整製作團隊。"
        action={<StatusPill tone={catalog.available ? 'good' : 'warning'}>{catalog.available ? '本機 Agent 已連線' : '目前使用安全備援'}</StatusPill>}
      />

      <div className="start-layout">
        <section className="script-composer">
          <div className="composer-toolbar">
            <span><FileText size={16} /> 劇本內容</span>
            <div>
              <button type="button" className="text-button" onClick={onExample}>放入範例</button>
              <button type="button" className="text-button muted" onClick={onReset}>清空</button>
            </div>
          </div>
          <textarea
            value={project.story}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onStoryChange(event.target.value)}
            placeholder={'直接貼上完整劇本、故事大綱或對話。\n\n編劇會先辨識角色、衝突、節奏、故事節點與場景需求；你的原始文字會保留在專案中。'}
            spellCheck={false}
            autoFocus
          />
          <div className="composer-footer">
            <span>{storyLength.toLocaleString()} 字</span>
            <span>{storyLength < 4 ? '至少輸入 4 個字' : storyLength > 100_000 ? '已超過 100,000 字上限' : '可送出'}</span>
          </div>
          {error && <div className="inline-error">{error}</div>}
        </section>

        <aside className="start-control-panel">
          <div className="control-card">
            <h3>作品設定</h3>
            <label>
              <span>作品方向</span>
              <select value={project.settings.mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('mode', event.target.value as ProjectMode)}>
                <option value="anime">精緻動畫</option>
                <option value="realistic">自然寫實</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <div className="compact-field-row">
              <label>
                <span>畫面比例</span>
                <select value={project.settings.format} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('format', event.target.value as EvolabsProject['settings']['format'])}>
                  <option value="9:16">9:16 直式</option>
                  <option value="16:9">16:9 橫式</option>
                  <option value="1:1">1:1 方形</option>
                </select>
                <ChevronDown size={14} />
              </label>
              <label>
                <span>目標長度</span>
                <select value={String(project.settings.targetSeconds)} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('targetSeconds', Number(event.target.value))}>
                  <option value="30">30 秒</option>
                  <option value="60">60 秒</option>
                  <option value="90">90 秒</option>
                  <option value="120">120 秒</option>
                </select>
                <ChevronDown size={14} />
              </label>
            </div>
          </div>

          <div className="control-card">
            <div className="card-title-row">
              <h3>編劇模型</h3>
              <button type="button" className="icon-text-button" onClick={onOpenModels}><BrainCircuit size={14} /> 管理模型</button>
            </div>
            <label>
              <span>這次使用</span>
              <select value={selectedModelId} onChange={(event: ChangeEvent<HTMLSelectElement>) => onModelChange(event.target.value)}>
                <option value="auto">自動選擇（建議）</option>
                {catalog.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}{model.recommended ? ' · 建議' : ''}</option>
                ))}
                {selectedModelId !== 'auto' && !catalog.models.some((model) => model.id === selectedModelId) && (
                  <option value={selectedModelId}>{selectedModelId} · 尚未載入</option>
                )}
              </select>
              <ChevronDown size={14} />
            </label>
            <p className="field-note">目前：{selectedModel}</p>
          </div>

          <div className="readiness-card">
            <div><span className={hardware.runtimeReady ? 'ready-dot' : 'warning-dot'} /><p><strong>本機影片引擎</strong><small>{hardware.runtimeReady ? '可建立生成工作' : '尚未完成健康檢查'}</small></p></div>
            <div><span className={catalog.available ? 'ready-dot' : 'warning-dot'} /><p><strong>編劇 Agent</strong><small>{catalog.message}</small></p></div>
            <div><span className={hardware.aiReady ? 'ready-dot' : 'neutral-dot'} /><p><strong>視覺模型</strong><small>{hardware.aiReady ? hardware.aiProvider || '已就緒' : '稍後生成影片時再準備'}</small></p></div>
          </div>

          <button type="button" className="primary-action large" disabled={!ready || storyLength > 100_000} onClick={onSubmit}>
            {submitting ? <><RefreshCw size={17} className="spin" /> 編劇正在閱讀</> : <><Play size={17} /> 送交編劇</>}
          </button>
          <p className="action-footnote">送出後會先顯示編劇的真實交付結果，不會直接把你丟進不可理解的自動流程。</p>
        </aside>
      </div>
    </div>
  );
}
