import {
  BrainCircuit,
  Check,
  CirclePause,
  CirclePlay,
  Clapperboard,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Play,
  RefreshCw,
  Square,
  UsersRound,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { agentRoster, workspaceOverallProgress } from '../lib/agentPipeline';
import type { AgentModelCatalog } from '../lib/studioBridge';
import type { AgentWorkspace, EvolabsProject, RenderControlAction, RenderJobSnapshot } from '../types';
import { ProgressBar, SectionHeading, StatusPill } from './ui';

type ProductionTab = 'overview' | 'characters' | 'locations' | 'shots' | 'sound';

interface ProductionViewProps {
  project: EvolabsProject;
  workspace: AgentWorkspace;
  catalog: AgentModelCatalog;
  selectedModelId: string;
  writerReady: boolean;
  runningWriter: boolean;
  runningTeam: boolean;
  render: RenderJobSnapshot | null;
  pipelineError?: string;
  onContinueTeam: () => void;
  onStartRender: () => void;
  onControlRender: (action: RenderControlAction) => void;
  onReveal: () => void;
  onBackToScript: () => void;
  onRetryWriter: () => void;
}

function stageTone(status: string): 'good' | 'working' | 'bad' | 'neutral' | 'warning' {
  if (status === 'done') return 'good';
  if (status === 'working') return 'working';
  if (status === 'failed') return 'bad';
  if (status === 'blocked') return 'warning';
  return 'neutral';
}

function renderStateLabel(render: RenderJobSnapshot | null): string {
  if (!render) return '尚未開始';
  if (render.state === 'completed') return '成片完成';
  if (render.state === 'failed') return '生成失敗';
  if (render.state === 'canceled') return '已取消';
  if (render.state === 'paused') return '已暫停';
  return render.message || '正在生成';
}

export default function ProductionView({
  project,
  workspace,
  catalog,
  selectedModelId,
  writerReady,
  runningWriter,
  runningTeam,
  render,
  pipelineError,
  onContinueTeam,
  onStartRender,
  onControlRender,
  onReveal,
  onBackToScript,
  onRetryWriter,
}: ProductionViewProps) {
  const [tab, setTab] = useState<ProductionTab>('overview');
  const script = project.productionBible?.script;
  const locations = project.productionBible?.locations ?? [];
  const sound = project.productionBible?.sound;
  const review = project.productionBible?.directorReview;
  const modelLabel = selectedModelId === 'auto' ? catalog.selectedModel || '自動選擇' : selectedModelId;
  const teamReady = project.characters.length > 0 && project.scenes.length > 0 && Boolean(review);
  const progress = render && !['completed', 'failed', 'canceled'].includes(render.state)
    ? render.overallProgress
    : workspaceOverallProgress(workspace);
  const recentMessages = useMemo(() => workspace.messages.slice(-16), [workspace.messages]);

  return (
    <div className="studio-page production-page">
      <SectionHeading
        eyebrow="PRODUCTION"
        title={project.title || '未命名專案'}
        detail={script?.logline || '編劇尚未完成第一份交付。'}
        action={(
          <div className="heading-actions">
            <StatusPill tone={runningWriter || runningTeam ? 'working' : pipelineError ? 'bad' : teamReady ? 'good' : writerReady ? 'warning' : 'neutral'}>
              {runningWriter ? '編劇處理中' : runningTeam ? '製作團隊工作中' : teamReady ? '製作藍圖完成' : writerReady ? '等待進入完整製作' : '等待編劇'}
            </StatusPill>
            <button type="button" className="secondary-action" onClick={onBackToScript}>返回劇本</button>
          </div>
        )}
      />

      <div className="production-grid">
        <aside className="production-activity">
          <div className="activity-head">
            <span><BrainCircuit size={15} /> 團隊對話</span>
            <small>{modelLabel}</small>
          </div>
          <div className="message-stream">
            {recentMessages.map((message) => (
              <article key={message.id} className={`studio-message kind-${message.kind}`}>
                <header><strong>{message.sender}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</time></header>
                <p>{message.text}</p>
              </article>
            ))}
            {!recentMessages.length && <div className="empty-message">送交劇本後，編劇的接收與交付紀錄會顯示在這裡。</div>}
          </div>
          {pipelineError && (
            <div className="activity-error">
              <strong>目前流程需要處理</strong>
              <p>{pipelineError}</p>
              <button type="button" onClick={onRetryWriter}><RefreshCw size={14} /> 重新送交編劇</button>
            </div>
          )}
        </aside>

        <main className="production-main">
          <section className="stage-strip">
            {agentRoster.map((agent) => {
              const live = workspace.agents.find((item) => item.id === agent.id);
              return (
                <div key={agent.id} className={`stage-item state-${live?.status || 'idle'}`}>
                  <span>{live?.status === 'done' ? <Check size={13} /> : live?.status === 'working' ? <LoaderCircle size={13} className="spin" /> : agent.symbol}</span>
                  <p><strong>{agent.name}</strong><small>{live?.currentTask || '待命'}</small></p>
                  <StatusPill tone={stageTone(live?.status || 'idle')}>{live?.status === 'done' ? '完成' : live?.status === 'working' ? '工作中' : live?.status === 'failed' ? '失敗' : '待命'}</StatusPill>
                </div>
              );
            })}
          </section>

          <section className="production-summary-card">
            <div className="summary-progress">
              <span><strong>{Math.round(progress)}%</strong><small>{render ? renderStateLabel(render) : runningTeam ? '建立製作藍圖' : writerReady ? '編劇已交付' : '等待開始'}</small></span>
              <ProgressBar value={progress} />
            </div>
            {!writerReady && !runningWriter && <button type="button" className="primary-action" onClick={onRetryWriter}><FileText size={16} /> 送交編劇</button>}
            {writerReady && !teamReady && !runningTeam && <button type="button" className="primary-action" onClick={onContinueTeam}><Play size={16} /> 交給完整製作團隊</button>}
            {teamReady && (!render || ['failed', 'canceled'].includes(render.state)) && <button type="button" className="primary-action" onClick={onStartRender}><Film size={16} /> 生成成片</button>}
            {render && ['queued', 'running', 'pausing', 'paused', 'canceling'].includes(render.state) && (
              <div className="render-inline-controls">
                <button type="button" onClick={() => onControlRender(render.state === 'paused' ? 'resume' : 'pause')}>
                  {render.state === 'paused' ? <CirclePlay size={17} /> : <CirclePause size={17} />}
                </button>
                <button type="button" className="danger" onClick={() => onControlRender('cancel')}><Square size={15} /></button>
              </div>
            )}
            {render?.state === 'completed' && <button type="button" className="primary-action" onClick={onReveal}><ExternalLink size={16} /> 開啟成片</button>}
          </section>

          <nav className="production-tabs" aria-label="製作內容">
            {([
              ['overview', '概覽'],
              ['characters', `角色 ${project.characters.length || ''}`],
              ['locations', `場景 ${locations.length || ''}`],
              ['shots', `分鏡 ${project.scenes.length || ''}`],
              ['sound', '聲音'],
            ] as Array<[ProductionTab, string]>).map(([value, label]) => (
              <button key={value} type="button" className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>
            ))}
          </nav>

          <section className="production-content">
            {tab === 'overview' && (
              <div className="overview-layout">
                <article className="writer-delivery-card">
                  <header><FileText size={17} /><div><span>編劇交付</span><strong>{script?.title || '等待中'}</strong></div>{script && <StatusPill tone="good">已接收</StatusPill>}</header>
                  {script ? (
                    <>
                      <p className="logline">{script.logline}</p>
                      <dl>
                        <div><dt>類型</dt><dd>{script.genre}</dd></div>
                        <div><dt>調性</dt><dd>{script.tone}</dd></div>
                        <div><dt>主題</dt><dd>{script.theme}</dd></div>
                      </dl>
                      <div className="beat-list">{script.beats.slice(0, 8).map((beat, index) => <span key={beat.id}><i>{index + 1}</i>{beat.title}</span>)}</div>
                    </>
                  ) : <p className="empty-copy">劇本送達後，這裡會顯示編劇實際產生的故事結構。</p>}
                </article>
                <div className="overview-metrics">
                  <article><UsersRound size={17} /><span><strong>{project.characters.length}</strong><small>角色資產</small></span></article>
                  <article><ImageIcon size={17} /><span><strong>{locations.length}</strong><small>場景資產</small></span></article>
                  <article><Clapperboard size={17} /><span><strong>{project.scenes.length}</strong><small>分鏡鏡頭</small></span></article>
                  <article><Music2 size={17} /><span><strong>{sound?.cues.length || 0}</strong><small>聲音 Cue</small></span></article>
                  {review && <article className="wide"><Check size={17} /><span><strong>{review.score}/100</strong><small>{review.summary}</small></span></article>}
                </div>
              </div>
            )}

            {tab === 'characters' && (
              <div className="asset-grid">
                {project.characters.map((character) => (
                  <article key={character.id} className="asset-card">
                    <span className="asset-index">{character.name.slice(0, 1)}</span>
                    <div><header><strong>{character.name}</strong><StatusPill tone="good">身份鎖定</StatusPill></header><small>{character.role} · {character.voice}</small><p>{character.appearance}</p><footer>{character.wardrobe || character.identityAnchor}</footer></div>
                  </article>
                ))}
                {!project.characters.length && <p className="empty-copy">完整製作開始後，角色資產會出現在這裡。</p>}
              </div>
            )}

            {tab === 'locations' && (
              <div className="asset-grid">
                {locations.map((location) => (
                  <article key={location.id} className="asset-card location-card">
                    <span className="asset-index"><ImageIcon size={18} /></span>
                    <div><header><strong>{location.name}</strong><StatusPill tone="good">可重用</StatusPill></header><small>{location.timeOfDay} · {location.weather}</small><p>{location.environmentAnchor}</p><footer>{location.keyProps.join(' · ')}</footer></div>
                  </article>
                ))}
                {!locations.length && <p className="empty-copy">場景設計師尚未交付場景資產。</p>}
              </div>
            )}

            {tab === 'shots' && (
              <div className="shot-list">
                {project.scenes.map((scene) => (
                  <article key={scene.id}>
                    <span>{String(scene.order).padStart(2, '0')}</span>
                    <div><header><strong>{scene.title}</strong><StatusPill tone={scene.status === 'done' ? 'good' : scene.status === 'working' ? 'working' : scene.status === 'failed' ? 'bad' : 'neutral'}>{scene.status}</StatusPill></header><small>{scene.shot} · {scene.duration} 秒</small><p>{scene.visual}</p>{scene.dialogue && <blockquote>{scene.dialogue}</blockquote>}</div>
                  </article>
                ))}
                {!project.scenes.length && <p className="empty-copy">分鏡師尚未建立鏡頭序列。</p>}
              </div>
            )}

            {tab === 'sound' && (
              <div className="sound-panel">
                {sound ? <><article><h3>音樂方向</h3><p>{sound.musicDirection}</p></article><article><h3>混音方向</h3><p>{sound.mixDirection}</p></article><div className="sound-cues">{sound.cues.map((cue, index) => <span key={`${cue.sceneId}-${index}`}><strong>{index + 1}</strong><p>{cue.musicCue}<small>{cue.ambience}</small></p></span>)}</div></> : <p className="empty-copy">聲音導演尚未交付聲音計畫。</p>}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
