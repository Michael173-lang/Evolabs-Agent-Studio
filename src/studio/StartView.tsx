import type { ChangeEvent } from 'react';
import { ArrowRight, Film, FileText, MonitorCog, ShieldCheck, Sparkles } from 'lucide-react';
import type { EvolabsProject, VideoProviderStatus } from '../types';
import { SectionHeader, StatusPill } from './ui';

interface StartViewProps {
  project: EvolabsProject;
  agentReady: boolean;
  agentModelLabel: string;
  videoProvider: VideoProviderStatus;
  busy: boolean;
  onStoryChange: (story: string) => void;
  onSettingChange: <K extends keyof EvolabsProject['settings']>(key: K, value: EvolabsProject['settings'][K]) => void;
  onSubmitToWriter: () => void;
  onOpenModels: () => void;
  onUseSample: () => void;
  onContinue: () => void;
}

export default function StartView({
  project,
  agentReady,
  agentModelLabel,
  videoProvider,
  busy,
  onStoryChange,
  onSettingChange,
  onSubmitToWriter,
  onOpenModels,
  onUseSample,
  onContinue,
}: StartViewProps) {
  const hasProduction = Boolean(project.productionBible?.script || project.characters.length || project.scenes.length);
  const aiVideo = project.settings.visualMode === 'ai-video';
  const canSubmit = project.story.trim().length >= 4 && agentReady && !busy;

  return (
    <div className="page page--start">
      <SectionHeader
        eyebrow="劇本製作"
        title="從劇本開始"
        description="先由實際連線的 AI 編劇理解故事，再建立角色、場景與可交給影片模型執行的鏡頭。沒有本機模型回覆時，Evolabs 不會偽造對話或成果。"
        actions={hasProduction ? (
          <button className="button button--secondary" type="button" onClick={onContinue}>
            繼續目前製作 <ArrowRight size={16} />
          </button>
        ) : undefined}
      />

      <div className="start-grid">
        <section className="panel panel--primary script-entry">
          <div className="panel__header">
            <div>
              <span className="eyebrow">原始劇本</span>
              <h2>交給編劇的唯一來源</h2>
            </div>
            <button className="button button--ghost" type="button" onClick={onUseSample}>
              <FileText size={16} /> 使用範例
            </button>
          </div>
          <textarea
            className="script-editor"
            value={project.story}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onStoryChange(event.target.value)}
            placeholder="貼上完整故事、分場劇本或短劇構想。人物年齡、服裝與不能改動的設定請直接寫清楚。"
            spellCheck
            aria-label="劇本"
          />
          <div className="script-entry__footer">
            <span>{project.story.trim().length.toLocaleString()} 字</span>
            <span>最多 100,000 字</span>
          </div>
        </section>

        <aside className="start-options">
          <section className="panel">
            <div className="panel__header panel__header--compact">
              <div>
                <span className="eyebrow">製作設定</span>
                <h2>作品方向</h2>
              </div>
            </div>
            <div className="form-grid form-grid--two">
              <label className="field">
                <span>視覺方向</span>
                <select value={project.settings.mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('mode', event.target.value as EvolabsProject['settings']['mode'])}>
                  <option value="realistic">真人寫實</option>
                  <option value="anime">動畫風格</option>
                </select>
              </label>
              <label className="field">
                <span>畫面比例</span>
                <select value={project.settings.format} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSettingChange('format', event.target.value as EvolabsProject['settings']['format'])}>
                  <option value="9:16">9:16 直式</option>
                  <option value="16:9">16:9 橫式</option>
                  <option value="1:1">1:1 方形</option>
                </select>
              </label>
              <label className="field field--wide">
                <span>目標長度</span>
                <div className="range-row">
                  <input
                    type="range"
                    min={10}
                    max={180}
                    step={5}
                    value={project.settings.targetSeconds}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => onSettingChange('targetSeconds', Number(event.target.value))}
                  />
                  <strong>{project.settings.targetSeconds} 秒</strong>
                </div>
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="panel__header panel__header--compact">
              <div>
                <span className="eyebrow">生成模式</span>
                <h2>明確選擇輸出方式</h2>
              </div>
            </div>
            <div className="mode-choice" role="radiogroup" aria-label="生成模式">
              <button
                type="button"
                role="radio"
                aria-checked={aiVideo}
                className={`mode-card${aiVideo ? ' is-selected' : ''}`}
                onClick={() => onSettingChange('visualMode', 'ai-video')}
              >
                <Film size={20} />
                <span>
                  <strong>AI 影片</strong>
                  <small>每個鏡頭交由 AI 影片模型生成；影片模型服務尚未可用時不能開始。</small>
                </span>
                <StatusPill tone={videoProvider.available ? 'good' : 'warning'}>
                  {videoProvider.available ? '服務已連線' : '尚未設定'}
                </StatusPill>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!aiVideo}
                className={`mode-card${!aiVideo ? ' is-selected' : ''}`}
                onClick={() => onSettingChange('visualMode', 'motion-comic')}
              >
                <Sparkles size={20} />
                <span>
                  <strong>動態漫畫</strong>
                  <small>使用靜態畫面、字幕與簡單運鏡；不會標示為影片模型生成。</small>
                </span>
                <StatusPill>替代模式</StatusPill>
              </button>
            </div>
          </section>

          <section className="readiness-card">
            <div className="readiness-card__item">
              <ShieldCheck size={18} />
              <div>
                <strong>AI 編劇模型</strong>
                <span>{agentReady ? agentModelLabel : '尚未連線；不能送交編劇'}</span>
              </div>
              <StatusPill tone={agentReady ? 'good' : 'danger'}>{agentReady ? '可用' : '未連線'}</StatusPill>
            </div>
            <div className="readiness-card__item">
              <MonitorCog size={18} />
              <div>
                <strong>影片模型服務</strong>
                <span>{videoProvider.message}</span>
              </div>
              <StatusPill tone={videoProvider.available ? 'good' : aiVideo ? 'warning' : 'neutral'}>
                {videoProvider.available ? '可用' : '尚未完成設定'}
              </StatusPill>
            </div>
            {(!agentReady || (aiVideo && !videoProvider.available)) && (
              <button className="button button--secondary button--full" type="button" onClick={onOpenModels}>
                前往模型與執行環境
              </button>
            )}
          </section>

          <button className="button button--primary button--xl button--full" type="button" disabled={!canSubmit} onClick={onSubmitToWriter}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <FileText size={19} />}
            {busy ? 'AI 編劇正在回覆' : '送交 AI 編劇'}
            {!busy && <ArrowRight size={18} />}
          </button>
          {!agentReady && <p className="form-note form-note--danger">本機 AI 執行環境未連線時，系統不會將預寫文案或規則式備援標示為 AI 回覆。</p>}
        </aside>
      </div>
    </div>
  );
}
