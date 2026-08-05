import { convertFileSrc } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clapperboard,
  ExternalLink,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { agentRoster } from '../lib/agentPipeline';
import { isVisibleDialogueMessage } from '../lib/agentConversation';
import type {
  AgentChangeProposal,
  AgentId,
  ConversationTarget,
  EvolabsProject,
  RenderControlAction,
  RenderJobSnapshot,
  SystemActivityEvent,
} from '../types';
import { EmptyState, ProgressBar, SectionHeader, StatusPill } from './ui';

interface ProductionViewProps {
  project: EvolabsProject;
  render: RenderJobSnapshot | null;
  busy: boolean;
  selectedTarget: ConversationTarget;
  canRunTeam: boolean;
  canRender: boolean;
  referenceRequired: boolean;
  renderBlockedReason?: string;
  onSelectTarget: (target: ConversationTarget) => void;
  onSendMessage: (target: ConversationTarget, message: string) => Promise<void>;
  onRunTeam: () => void;
  onStartRender: () => void;
  onControlRender: (action: RenderControlAction) => void;
  onReviewScene: (sceneId: string, approved: boolean, feedback: string) => Promise<void>;
  onImportCharacterReference: (characterId: string, dataUrl: string, fileName: string) => Promise<void>;
  onClearCharacterReference: (characterId: string) => Promise<void>;
  onRevealOutput: () => void;
  onApplyProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
  onBackToScript: () => void;
}

type ProductionTab = 'dialogue' | 'activity' | 'deliverables' | 'shots';

function localMediaUrl(path?: string): string | undefined {
  if (!path) return undefined;
  if (path.startsWith('data:') || path.startsWith('blob:') || path.startsWith('http:') || path.startsWith('https:')) return path;
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? convertFileSrc(path) : undefined;
  } catch {
    return undefined;
  }
}

function agentLabel(agentId?: AgentId): string {
  return agentRoster.find((agent) => agent.id === agentId)?.name ?? 'AI 製片成員';
}

const referenceImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const maximumReferenceBytes = 10 * 1024 * 1024;

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('參考圖讀取結果無效。'));
    reader.onerror = () => reject(new Error('無法讀取參考圖檔案。'));
    reader.readAsDataURL(file);
  });
}


const reviewChecklistItems = [
  { id: 'identity', label: '人物年齡、身份與服裝符合角色設定' },
  { id: 'anatomy', label: '沒有多眼、多臉、額外肢體、畸形手腳或裸露' },
  { id: 'continuity', label: '角色外觀、場景與關鍵道具在鏡頭內保持一致' },
  { id: 'motion', label: '人物與鏡頭具有真正連續動作，不是靜態畫面推拉' },
  { id: 'story', label: '動作、情緒與對白符合此鏡頭的敘事目的' },
] as const;

type ReviewChecklistId = typeof reviewChecklistItems[number]['id'];

function activityCategoryLabel(category: SystemActivityEvent['category']): string {
  if (category === 'runtime') return '本機執行環境';
  if (category === 'agent') return 'AI 製片成員';
  if (category === 'video') return '影片生成';
  if (category === 'validation') return '內容驗證';
  return '專案儲存';
}

function taskStateLabel(state: string): string {
  if (state === 'done') return '已完成';
  if (state === 'working') return '執行中';
  if (state === 'blocked') return '等待必要資料';
  if (state === 'failed') return '執行失敗';
  return '尚未開始';
}

function activityTone(level: SystemActivityEvent['level']): 'neutral' | 'good' | 'warning' | 'danger' | 'working' {
  if (level === 'success') return 'good';
  if (level === 'warning') return 'warning';
  if (level === 'error') return 'danger';
  if (level === 'working') return 'working';
  return 'neutral';
}

function taskTone(state: string): 'neutral' | 'good' | 'warning' | 'danger' | 'working' {
  if (state === 'done') return 'good';
  if (state === 'failed') return 'danger';
  if (state === 'blocked') return 'warning';
  if (state === 'working') return 'working';
  return 'neutral';
}

function ProposalCard({
  proposal,
  onApply,
  onReject,
}: {
  proposal: AgentChangeProposal;
  onApply: () => void;
  onReject: () => void;
}) {
  return (
    <article className="proposal-card">
      <div className="proposal-card__header">
        <div>
          <span className="eyebrow">可套用修改</span>
          <strong>{proposal.title}</strong>
        </div>
        <StatusPill tone={proposal.status === 'applied' ? 'good' : proposal.status === 'rejected' ? 'danger' : 'warning'}>
          {proposal.status === 'applied' ? '已套用' : proposal.status === 'rejected' ? '已拒絕' : '等待決定'}
        </StatusPill>
      </div>
      <p>{proposal.summary}</p>
      <small>{proposal.operations.length} 個受限制的專案修改操作</small>
      {proposal.status === 'pending' && (
        <div className="proposal-card__actions">
          <button className="button button--secondary" type="button" onClick={onReject}><X size={15} /> 拒絕</button>
          <button className="button button--primary" type="button" onClick={onApply}><Check size={15} /> 套用至專案</button>
        </div>
      )}
    </article>
  );
}

export default function ProductionView({
  project,
  render,
  busy,
  selectedTarget,
  canRunTeam,
  canRender,
  referenceRequired,
  renderBlockedReason,
  onSelectTarget,
  onSendMessage,
  onRunTeam,
  onStartRender,
  onControlRender,
  onReviewScene,
  onImportCharacterReference,
  onClearCharacterReference,
  onRevealOutput,
  onApplyProposal,
  onRejectProposal,
  onBackToScript,
}: ProductionViewProps) {
  const [tab, setTab] = useState<ProductionTab>('dialogue');
  const [message, setMessage] = useState('');
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [referenceBusyId, setReferenceBusyId] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [reviewChecks, setReviewChecks] = useState<Record<ReviewChecklistId, boolean>>({
    identity: false,
    anatomy: false,
    continuity: false,
    motion: false,
    story: false,
  });
  const workspace = project.agentWorkspace;
  const dialogue = (workspace?.messages ?? []).filter((entry) => {
    if (!isVisibleDialogueMessage(entry)) return false;
    const target = entry.conversationTarget ?? entry.agentId ?? 'screenwriter';
    return target === selectedTarget;
  });
  const visibleProposalIds = new Set(dialogue.map((entry) => entry.proposalId).filter((id): id is string => Boolean(id)));
  const activities = workspace?.activities ?? [];
  const proposals = workspace?.proposals ?? [];
  const tasks = workspace?.tasks ?? [];
  const activeReview = render?.state === 'awaiting-review'
    ? render.scenes.find((scene) => scene.sceneId === render.activeSceneId && scene.state === 'review')
    : undefined;
  const activeScene = activeReview ? project.scenes.find((scene) => scene.id === activeReview.sceneId) : undefined;
  const previewUrl = localMediaUrl(activeReview?.previewPath);
  const reviewApprovedByUser = reviewChecklistItems.every((item) => reviewChecks[item.id]);
  const referenceEditingDisabled = busy || Boolean(render && !['completed', 'failed', 'canceled'].includes(render.state));

  useEffect(() => {
    setReviewChecks({ identity: false, anatomy: false, continuity: false, motion: false, story: false });
    setReviewFeedback('');
  }, [activeReview?.sceneId, activeReview?.generationAttempt]);
  const completedTasks = tasks.filter((task) => task.state === 'done').length;
  const taskProgress = tasks.length ? tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length : 0;
  const tabs: Array<{ id: ProductionTab; label: string; count?: number }> = [
    { id: 'dialogue', label: 'AI 對話', count: dialogue.length },
    { id: 'activity', label: '系統活動', count: activities.length },
    { id: 'deliverables', label: '交付物' },
    { id: 'shots', label: '鏡頭', count: project.scenes.length },
  ];

  const targetOptions = useMemo(() => [
    { id: 'production-meeting' as const, label: '製作會議', detail: '八位 AI 製片成員依序提供真實模型回覆' },
    ...agentRoster.map((agent) => ({ id: agent.id, label: agent.name, detail: agent.title })),
  ], []);

  const importReference = async (characterId: string, file: File | undefined, input: HTMLInputElement) => {
    input.value = '';
    if (!file || referenceBusyId || referenceEditingDisabled) return;
    setReferenceError('');
    setReferenceBusyId(characterId);
    try {
      if (!referenceImageTypes.has(file.type)) throw new Error('只接受 PNG、JPEG 或 WebP 參考圖。');
      if (file.size <= 0) throw new Error('參考圖檔案是空的。');
      if (file.size > maximumReferenceBytes) throw new Error('參考圖超過 10 MB 上限。');
      const dataUrl = await readImageAsDataUrl(file);
      if (!dataUrl.startsWith('data:image/')) throw new Error('參考圖內容格式無效。');
      await onImportCharacterReference(characterId, dataUrl, file.name);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : '參考圖匯入失敗。');
    } finally {
      setReferenceBusyId('');
    }
  };

  const clearReference = async (characterId: string) => {
    if (referenceBusyId || referenceEditingDisabled) return;
    setReferenceError('');
    setReferenceBusyId(characterId);
    try {
      await onClearCharacterReference(characterId);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : '參考圖移除失敗。');
    } finally {
      setReferenceBusyId('');
    }
  };

  const send = async () => {
    const trimmed = message.trim();
    if (!trimmed || sending || busy) return;
    setSending(true);
    try {
      await onSendMessage(selectedTarget, trimmed);
      setMessage('');
      setTab('dialogue');
    } finally {
      setSending(false);
    }
  };

  const review = async (approved: boolean) => {
    if (!activeReview || reviewing) return;
    if (approved && !reviewApprovedByUser) return;
    const feedback = reviewFeedback.trim();
    if (!approved && !feedback) return;
    setReviewing(true);
    try {
      await onReviewScene(activeReview.sceneId, approved, feedback);
      setReviewFeedback('');
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="page page--production">
      <SectionHeader
        eyebrow="影片製作"
        title={project.title || '未命名專案'}
        description={project.productionBible?.script?.logline ?? '等待 AI 編劇交付可驗證的故事分析。'}
        actions={(
          <div className="button-row">
            <button className="button button--ghost" type="button" onClick={onBackToScript}>返回劇本</button>
            {render?.state === 'completed' ? (
              <button className="button button--primary" type="button" onClick={onRevealOutput}><ExternalLink size={16} /> 開啟成片</button>
            ) : (
              <button className="button button--primary" type="button" disabled={!canRender || Boolean(render && !['failed', 'canceled', 'completed'].includes(render.state))} onClick={onStartRender}>
                <Clapperboard size={16} /> 生成影片
              </button>
            )}
          </div>
        )}
      />

      <section className="production-status panel">
        <div className="production-status__summary">
          <div>
            <span className="metric-value">{render ? Math.round(render.overallProgress) : Math.round(taskProgress)}%</span>
            <small>{render ? render.message ?? '影片工作進行中' : `${completedTasks} / ${tasks.length || 8} 個 AI 製作階段完成`}</small>
          </div>
          <ProgressBar value={render ? render.overallProgress : taskProgress} />
        </div>
        <div className="production-status__actions">
          {!project.productionBible?.directorReview?.approved && (
            <button className="button button--secondary" type="button" disabled={!canRunTeam || busy} onClick={onRunTeam}>
              {busy ? <span className="spinner" /> : <Users size={16} />} 開始 AI 製片流程
            </button>
          )}
          {render && ['queued', 'running'].includes(render.state) && (
            <button className="button button--ghost" type="button" onClick={() => onControlRender('pause')}><CirclePause size={16} /> 暫停</button>
          )}
          {render?.state === 'paused' && (
            <button className="button button--ghost" type="button" onClick={() => onControlRender('resume')}><CirclePlay size={16} /> 繼續</button>
          )}
          {render && !['completed', 'failed', 'canceled'].includes(render.state) && (
            <button className="button button--danger" type="button" onClick={() => onControlRender('cancel')}><Square size={14} /> 停止</button>
          )}
        </div>
      </section>

      {renderBlockedReason && !render && <div className="inline-alert"><AlertTriangle size={17} /><span>{renderBlockedReason}</span></div>}

      {activeReview && (
        <section className="review-panel panel panel--emphasis">
          <div className="panel__header">
            <div>
              <span className="eyebrow">逐鏡必要審核</span>
              <h2>核准第 {activeScene?.order ?? '?'} 鏡之前，影片不會進入成片</h2>
              <p>{activeScene?.title} · 第 {activeReview.generationAttempt ?? 1} 次生成</p>
            </div>
            <StatusPill tone="warning">等待人工審核</StatusPill>
          </div>
          <div className="review-grid">
            <div className="review-player">
              {previewUrl ? <video controls preload="metadata" src={previewUrl} /> : <EmptyState title="無法載入預覽" description={activeReview.previewPath ?? '引擎尚未提供鏡頭路徑。'} />}
            </div>
            <div className="review-checklist">
              <h3>人工核准清單</h3>
              <p className="review-checklist__note">目前沒有可靠的本機語意檢測器能完全取代人工判斷。請逐項確認後再核准。</p>
              <div className="review-confirmations">
                {reviewChecklistItems.map((item) => (
                  <label className="review-confirmation" key={item.id}>
                    <input
                      type="checkbox"
                      checked={reviewChecks[item.id]}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setReviewChecks((current) => ({ ...current, [item.id]: event.target.checked }))}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
              <div className="quality-list">
                {(activeReview.qualityChecks ?? []).map((check) => (
                  <div className="quality-item" key={check.id}>
                    <StatusPill tone={check.state === 'passed' ? 'good' : check.state === 'failed' ? 'danger' : check.state === 'pending' ? 'warning' : 'neutral'}>{check.label}</StatusPill>
                    <span>{check.detail}</span>
                  </div>
                ))}
              </div>
              <label className="field">
                <span>退回原因</span>
                <textarea value={reviewFeedback} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReviewFeedback(event.target.value)} placeholder="例如：主角多出一隻眼睛、服裝不完整、看起來變成老人。" />
              </label>
              <div className="button-row button-row--end">
                <button className="button button--danger" type="button" disabled={reviewing || !reviewFeedback.trim()} onClick={() => void review(false)}>
                  <RefreshCw size={16} /> 退回重生
                </button>
                <button className="button button--primary" type="button" disabled={reviewing || !reviewApprovedByUser} onClick={() => void review(true)}>
                  <Check size={16} /> 核准此鏡頭
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="production-grid">
        <aside className="panel agent-tasks">
          <div className="panel__header panel__header--compact">
            <div>
              <span className="eyebrow">AI 製片團隊</span>
              <h2>真實執行狀態</h2>
            </div>
          </div>
          <div className="task-list">
            {tasks.map((task) => (
              <div className="task-row" key={task.id}>
                <span className="task-row__icon">{task.state === 'done' ? <Check size={14} /> : task.state === 'working' ? <span className="spinner spinner--small" /> : <ChevronRight size={14} />}</span>
                <div>
                  <strong>{agentLabel(task.agentId)}</strong>
                  <small>{task.detail}</small>
                  {task.modelId && <small>{task.modelId}{task.requestId ? ` · ${task.requestId.slice(0, 12)}` : ''}</small>}
                </div>
                <StatusPill tone={taskTone(task.state)}>{taskStateLabel(task.state)}</StatusPill>
              </div>
            ))}
          </div>
        </aside>

        <main className="panel production-main">
          <nav className="tabs" aria-label="製作內容">
            {tabs.map((item) => (
              <button type="button" className={tab === item.id ? 'is-active' : ''} key={item.id} onClick={() => setTab(item.id)}>
                {item.label}{typeof item.count === 'number' && <span>{item.count}</span>}
              </button>
            ))}
          </nav>

          {tab === 'dialogue' && (
            <div className="dialogue-layout">
              <div className="dialogue-list" aria-live="polite">
                {!dialogue.length && (
                  <EmptyState
                    title="尚無 AI 回覆"
                    description="對話區只會顯示你送出的訊息與模型真正回傳的最終回答；系統進度不會冒充 Agent 說話。"
                  />
                )}
                {dialogue.map((entry) => (
                  <article className={`message message--${entry.kind}`} key={entry.id}>
                    <div className="message__meta">
                      <strong>{entry.kind === 'user' ? '你' : agentLabel(entry.agentId)}</strong>
                      <time>{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                    <p>{entry.text}</p>
                    {entry.evidence && (
                      <details className="evidence">
                        <summary>模型執行證據</summary>
                        <dl>
                          <div><dt>模型</dt><dd>{entry.evidence.modelId}</dd></div>
                          <div><dt>要求識別碼</dt><dd>{entry.evidence.requestId}</dd></div>
                          <div><dt>延遲</dt><dd>{(entry.evidence.latencyMs / 1000).toFixed(1)} 秒</dd></div>
                          <div><dt>結構驗證</dt><dd>{entry.evidence.schemaValid ? '通過' : '失敗'}</dd></div>
                          {entry.evidence.usage?.totalTokens && <div><dt>模型用量</dt><dd>{entry.evidence.usage.totalTokens.toLocaleString()} 個 Token</dd></div>}
                        </dl>
                        {entry.evidence.acknowledgement && (
                          <div className="acknowledgement">
                            <strong>任務確認</strong>
                            <p>{entry.evidence.acknowledgement.objective}</p>
                            {!!entry.evidence.acknowledgement.missingInformation.length && (
                              <ul>{entry.evidence.acknowledgement.missingInformation.map((item) => <li key={item}>{item}</li>)}</ul>
                            )}
                          </div>
                        )}
                      </details>
                    )}
                  </article>
                ))}
                {proposals.filter((proposal) => proposal.status === 'pending' && visibleProposalIds.has(proposal.id)).map((proposal) => (
                  <ProposalCard key={proposal.id} proposal={proposal} onApply={() => onApplyProposal(proposal.id)} onReject={() => onRejectProposal(proposal.id)} />
                ))}
              </div>
              <div className="composer">
                <label className="field composer__target">
                  <span>交談對象</span>
                  <select value={selectedTarget} onChange={(event: ChangeEvent<HTMLSelectElement>) => onSelectTarget(event.target.value as ConversationTarget)}>
                    {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.label} — {target.detail}</option>)}
                  </select>
                </label>
                <textarea
                  value={message}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setMessage(event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="提出修改、追問原因，或請 AI 製片成員更新角色、分鏡與導演要求。Enter 送出，Shift+Enter 換行。"
                />
                <button className="button button--primary composer__send" type="button" disabled={!message.trim() || sending || busy} onClick={() => void send()}>
                  {sending ? <span className="spinner" /> : <Send size={17} />} 送出
                </button>
              </div>
            </div>
          )}

          {tab === 'activity' && (
            <div className="activity-list">
              {!activities.length && <EmptyState title="尚無系統活動" description="模型呼叫、驗證、錯誤與影片工作會顯示在這裡，不會混入 AI 對話。" />}
              {[...activities].reverse().map((event) => (
                <article className="activity-row" key={event.id}>
                  <StatusPill tone={activityTone(event.level)}>{activityCategoryLabel(event.category)}</StatusPill>
                  <div>
                    <strong>{event.title}</strong>
                    {event.detail && <p>{event.detail}</p>}
                    <small>{new Date(event.createdAt).toLocaleString()} {event.modelId ? `· ${event.modelId}` : ''} {event.durationMs ? `· ${(event.durationMs / 1000).toFixed(1)} 秒` : ''}</small>
                  </div>
                </article>
              ))}
            </div>
          )}

          {tab === 'deliverables' && (
            <div className="deliverables">
              <article><span className="eyebrow">編劇</span><h3>{project.productionBible?.script?.title ?? '尚未交付'}</h3><p>{project.productionBible?.script?.summary ?? '請先將劇本送交已連線的 AI 編劇。'}</p></article>
              <article><span className="eyebrow">角色</span><h3>{project.characters.length} 名</h3><p>{project.characters.map((character) => `${character.name}（${character.age ?? '年齡未設定'}，${character.wardrobe ?? '服裝未設定'}）`).join('、') || '尚未建立角色資產。'}</p></article>
              <article><span className="eyebrow">場景</span><h3>{project.productionBible?.locations?.length ?? 0} 個</h3><p>{project.productionBible?.locations?.map((location) => location.name).join('、') || '尚未建立場景資產。'}</p></article>
              <article><span className="eyebrow">總導演驗收</span><h3>{project.productionBible?.directorReview?.approved ? '已核准' : '尚未核准'}</h3><p>{project.productionBible?.directorReview?.summary ?? '必須完成所有 AI 專業交付並通過總導演驗收。'}</p></article>
              <section className="reference-manager" aria-labelledby="reference-manager-title">
                <div className="reference-manager__header">
                  <div>
                    <span className="eyebrow">角色身份資產</span>
                    <h3 id="reference-manager-title">角色身份參考圖</h3>
                    <p>參考圖由你明確匯入，不會由舊版靜態圖片模型自動冒充角色身份。更換參考圖後，相關鏡頭必須重新生成並重新審核。</p>
                  </div>
                  <StatusPill tone={referenceRequired ? 'warning' : 'neutral'}>{referenceRequired ? '目前工作流必要' : '目前工作流選用'}</StatusPill>
                </div>
                {referenceRequired && (
                  <div className="inline-alert">
                    <AlertTriangle size={17} />
                    <span>目前的參考圖轉影片工作流只接受每鏡頭一名角色及一張身份參考圖；多人鏡頭必須先拆分，或改用支援多人參考的影片工作流。</span>
                  </div>
                )}
                {referenceError && <p className="form-note form-note--danger">{referenceError}</p>}
                {!project.characters.length ? (
                  <EmptyState title="尚無角色" description="AI 角色設計交付完成後，才能匯入身份參考圖。" />
                ) : (
                  <div className="reference-grid">
                    {project.characters.map((character) => {
                      const imageUrl = character.referenceImageDataUrl ?? localMediaUrl(character.referenceImagePath);
                      const isBusy = referenceBusyId === character.id;
                      const hasReference = Boolean(character.referenceImagePath || character.referenceImageDataUrl);
                      return (
                        <article className="reference-card" key={character.id}>
                          <div className="reference-preview">
                            {imageUrl ? <img src={imageUrl} alt={`${character.name} 身份參考圖`} /> : <Users size={34} aria-hidden="true" />}
                          </div>
                          <div className="reference-card__body">
                            <div className="reference-card__title">
                              <div>
                                <strong>{character.name}</strong>
                                <small>{character.age ?? '年齡未設定'} · {character.wardrobe ?? '服裝未設定'}</small>
                              </div>
                              <StatusPill tone={hasReference ? 'good' : referenceRequired ? 'danger' : 'neutral'}>{hasReference ? '已匯入' : '尚未匯入'}</StatusPill>
                            </div>
                            <p>{character.referenceImageName ?? '尚未選擇身份參考圖。'}</p>
                            <div className="reference-card__actions">
                              <label className={`button button--secondary reference-upload${referenceEditingDisabled || isBusy ? ' is-disabled' : ''}`}>
                                {isBusy ? <span className="spinner" /> : <Clapperboard size={16} />}
                                {hasReference ? '更換參考圖' : '匯入參考圖'}
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                                  disabled={referenceEditingDisabled || Boolean(referenceBusyId)}
                                  onChange={(event: ChangeEvent<HTMLInputElement>) => void importReference(character.id, event.currentTarget.files?.[0], event.currentTarget)}
                                />
                              </label>
                              {hasReference && (
                                <button className="button button--ghost" type="button" disabled={referenceEditingDisabled || Boolean(referenceBusyId)} onClick={() => void clearReference(character.id)}>
                                  <Trash2 size={15} /> 移除
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
              {proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onApply={() => onApplyProposal(proposal.id)} onReject={() => onRejectProposal(proposal.id)} />)}
            </div>
          )}

          {tab === 'shots' && (
            <div className="shot-list">
              {!project.scenes.length && <EmptyState title="尚無影片鏡頭" description="完成 AI 分鏡設計後，這裡會顯示真正影片模型所需的提示、動作、時長與審核狀態。" />}
              {project.scenes.map((scene) => {
                const snapshot = render?.scenes.find((candidate) => candidate.sceneId === scene.id);
                return (
                  <article className="shot-card" key={scene.id}>
                    <div className="shot-card__number">{String(scene.order).padStart(2, '0')}</div>
                    <div className="shot-card__body">
                      <div className="shot-card__title">
                        <h3>{scene.title}</h3>
                        <StatusPill tone={snapshot?.reviewState === 'approved' ? 'good' : snapshot?.state === 'failed' ? 'danger' : snapshot?.state === 'review' ? 'warning' : snapshot?.state === 'working' ? 'working' : 'neutral'}>
                          {snapshot?.reviewState === 'approved' ? '已核准' : snapshot?.state === 'review' ? '等待審核' : snapshot?.state === 'working' ? '生成中' : snapshot?.state === 'failed' ? '失敗' : '尚未生成'}
                        </StatusPill>
                      </div>
                      <p>{scene.action || scene.visual}</p>
                      <dl className="shot-meta">
                        <div><dt>時長</dt><dd>{scene.duration} 秒</dd></div>
                        <div><dt>鏡頭</dt><dd>{scene.shot}</dd></div>
                        <div><dt>來源</dt><dd>{snapshot?.visualSource === 'video' ? '影片模型' : project.settings.visualMode === 'motion-comic' ? '動態漫畫' : '等待生成'}</dd></div>
                        {snapshot?.modelName && <div><dt>工作流／模型</dt><dd>{snapshot.modelName}</dd></div>}
                      </dl>
                      <details><summary>影片提示</summary><p>{scene.videoPrompt ?? scene.motionPrompt ?? scene.visual}</p><p className="muted">負向限制：{scene.negativePrompt}</p></details>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
