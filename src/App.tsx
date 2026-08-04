import {
  Bot,
  Box,
  BrainCircuit,
  Check,
  ChevronDown,
  CirclePause,
  CirclePlay,
  Clapperboard,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Film,
  Focus,
  Gauge,
  GitBranch,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  UserRound,
  UsersRound,
  Volume2,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  checkAppUpdate,
  controlModelInstall,
  controlRenderJob,
  getAgentRuntime,
  getAiRuntimeSetup,
  getHardwareProfile,
  getModelInstall,
  getRenderJob,
  installAppUpdate,
  isDemoBridge,
  loadProject,
  readLocalImage,
  revealRenderOutput,
  runAgentStage,
  saveProject,
  startModelInstall,
  startAiRuntimeSetup,
  startRenderJob,
} from './lib/bridge';
import {
  agentRoster,
  applyPlanToWorkspace,
  createAgentWorkspace,
  applyArtifactToWorkspace,
  createFallbackProduction,
  normalizeArtDirection,
  normalizeCharacters,
  normalizeDirectorReview,
  normalizeIpBible,
  normalizeLocations,
  normalizeScriptAnalysis,
  normalizeSound,
  normalizeStoryboard,
  productionPlan,
  refreshScriptNode,
  setAgentPhase,
  syncWorkspaceWithRender,
  workspaceOverallProgress,
} from './lib/agentPipeline';
import { createId } from './lib/id';
import { planningFingerprint } from './lib/planner';
import { createBlankProject, sampleStory } from './state/defaultProject';
import type {
  AgentCanvasNode,
  AgentId,
  AgentRuntimeProfile,
  AgentStage,
  AgentTaskState,
  AgentWorkspace,
  AppUpdateInfo,
  EvolabsProject,
  HardwareProfile,
  ModelInstallSnapshot,
  ModelPackStatus,
  ProductionBible,
  ProjectMode,
  QualityPreset,
  RenderControlAction,
  RenderJobSnapshot,
  RenderSceneSnapshot,
  RuntimeCapabilities,
  RuntimeSetupSnapshot,
  Scene,
} from './types';

const renderSessionKey = 'evolabs:render-session';
const modelInstallSessionKey = 'evolabs:model-install-session';
const openRailAcceptedKey = 'evolabs:openrail-accepted';
const openRailLicenseId = 'creativeml-openrail-m';
const openRailLicenseUrl = 'https://huggingface.co/spaces/CompVis/stable-diffusion-license';
const terminalRenderStates = new Set<RenderJobSnapshot['state']>(['completed', 'failed', 'canceled']);
const canvasSize = { width: 3600, height: 2300 };

const noAiCapabilities: RuntimeCapabilities = {
  comicCore: false,
  animeImage: false,
  realisticImage: false,
  characterConsistency: false,
  animeReference: false,
  realisticReference: false,
  multiCharacterReference: false,
  zhVoice: false,
  lipSync: false,
  imageToVideo: false,
};

const defaultHardware: HardwareProfile = {
  gpu: '正在偵測顯示卡',
  vramMb: 0,
  ramGb: 0,
  cpu: '正在偵測處理器',
  profile: 'low-vram',
  runtimeReady: false,
  aiReady: false,
  capabilities: noAiCapabilities,
};

const defaultAgentRuntime: AgentRuntimeProfile = {
  available: false,
  provider: 'fallback',
  message: '正在檢查本機 Agent…',
};

const defaultRuntimeSetup: RuntimeSetupSnapshot = {
  state: 'idle',
  stage: 'system',
  progress: 0,
  title: '準備 Evolabs AI Studio',
  message: '正在確認本機環境。',
  updatedAtUnixMs: Date.now(),
  steps: [
    { id: 'system', title: '檢查電腦與核心', state: 'queued', detail: '確認本機引擎、GPU 與儲存空間' },
    { id: 'llmster', title: '準備 AI Agent 服務', state: 'queued', detail: '安裝或修復 LM Studio llmster 後台' },
    { id: 'model', title: '下載 Agent 大腦', state: 'queued', detail: '依硬體選擇本機模型與量化' },
    { id: 'load', title: '載入並最佳化', state: 'queued', detail: '設定 GPU offload、上下文與自動卸載' },
    { id: 'verify', title: '最終健康檢查', state: 'queued', detail: '確認 Agent API 可直接被 Evolabs 使用' },
  ],
};

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function runtimeCapabilities(hardware: HardwareProfile): RuntimeCapabilities {
  return hardware.capabilities ?? { ...noAiCapabilities, comicCore: hardware.runtimeReady };
}

export function aiImagesReady(project: EvolabsProject, hardware: HardwareProfile): boolean {
  const capabilities = runtimeCapabilities(hardware);
  return project.settings.mode === 'anime' ? capabilities.animeImage : capabilities.realisticImage;
}

export function renderReadiness(project: EvolabsProject, hardware: HardwareProfile): { ready: boolean; reason?: string } {
  if (!hardware.runtimeReady) return { ready: false, reason: '本機引擎尚未就緒。' };
  const capabilities = runtimeCapabilities(hardware);
  if (project.settings.lipSync && project.settings.visualMode !== 'ai-images') {
    return { ready: false, reason: '單人對嘴需要 AI 畫面模式。' };
  }
  if (project.settings.lipSync && !capabilities.lipSync) {
    return { ready: false, reason: '本機單人對嘴執行器尚未就緒。' };
  }
  if (project.settings.visualMode !== 'ai-images') {
    return capabilities.comicCore ? { ready: true } : { ready: false, reason: '快速分鏡核心尚未就緒。' };
  }
  if (!aiImagesReady(project, hardware)) {
    return {
      ready: false,
      reason: project.settings.mode === 'anime' ? '動漫 AI 畫面模型尚未就緒。' : '寫實 AI 畫面模型尚未就緒。',
    };
  }
  return { ready: true };
}

export function renderErrorGuidance(code?: string): { title: string; message: string } | null {
  const normalized = code?.trim().toUpperCase() ?? '';
  if (/MODEL|PACK|WEIGHT|AI_IMAGE_UNAVAILABLE/.test(normalized)) {
    return { title: 'AI 模型尚未就緒', message: 'Evo 導演會保留目前進度；修復或安裝模型後即可接著生成。' };
  }
  if (/CUDA|VRAM|OUT_OF_MEMORY|OOM/.test(normalized)) {
    return { title: '顯示記憶體不足', message: '請切換「快速」品質；Evolabs 會在 4GB 安全路徑逐鏡處理。' };
  }
  if (/REFERENCE|IDENTITY|CONSISTENCY/.test(normalized)) {
    return { title: '角色一致性參考失敗', message: '請移除損壞的參考圖，代理團隊會保留角色描述並重新生成。' };
  }
  if (/DISK|NO_SPACE|STORAGE/.test(normalized)) {
    return { title: '儲存空間不足', message: '請釋放磁碟空間；未完成內容不會覆蓋已完成的鏡頭。' };
  }
  if (/ENGINE_EXITED|RUNTIME/.test(normalized)) {
    return { title: '本機引擎停止', message: '重新檢查本機核心後即可接回工作。' };
  }
  return null;
}

export function mergeRenderSceneState(scenes: Scene[], snapshots: RenderSceneSnapshot[]): Scene[] {
  const renderScenes = new Map(snapshots.map((scene) => [scene.sceneId, scene]));
  let changed = false;
  const merged = scenes.map((scene) => {
    const latest = renderScenes.get(scene.id);
    if (!latest) return scene;
    const progress = Math.max(0, Math.min(100, latest.progress));
    if (
      scene.status === latest.state
      && scene.progress === progress
      && scene.previewPath === latest.previewPath
      && scene.visualSource === latest.visualSource
    ) return scene;
    changed = true;
    return {
      ...scene,
      status: latest.state,
      progress,
      previewPath: latest.previewPath,
      visualSource: latest.visualSource,
    };
  });
  return changed ? merged : scenes;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '本機服務沒有回應。';
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function requiredAiPackId(project: EvolabsProject, hardware: HardwareProfile): string {
  const keyword = project.settings.mode === 'anime' ? 'anime' : 'realistic';
  return hardware.modelPacks?.find((pack) => pack.id.toLowerCase().includes(keyword))?.id ?? `${keyword}-core`;
}

function terminalInstall(install: ModelInstallSnapshot | null): boolean {
  return Boolean(install && ['completed', 'failed', 'canceled'].includes(install.state));
}

function agentStateLabel(state: AgentTaskState | 'idle'): string {
  if (state === 'working') return '工作中';
  if (state === 'done') return '已交付';
  if (state === 'blocked') return '等待中';
  if (state === 'failed') return '失敗';
  if (state === 'queued') return '排隊中';
  return '待命';
}

function nodeIcon(kind: AgentCanvasNode['kind']) {
  if (kind === 'script' || kind === 'script-analysis') return FileText;
  if (kind === 'art-direction') return Sparkles;
  if (kind === 'ip-bible') return ShieldCheck;
  if (kind === 'characters' || kind === 'character') return UsersRound;
  if (kind === 'locations' || kind === 'location') return ImageIcon;
  if (kind === 'storyboard' || kind === 'shot') return Clapperboard;
  if (kind === 'sound') return Music2;
  if (kind === 'director-review') return Focus;
  if (kind === 'render') return Film;
  return Workflow;
}

function Logo() {
  return (
    <div className="evo-brand" aria-label="Evolabs">
      <span className="evo-brand-mark">e</span>
      <span className="evo-brand-name">evolabs</span>
      <span className="evo-version">Agent Studio 0.6.0</span>
    </div>
  );
}

function useLocalPreview(path?: string, embedded?: string) {
  const [source, setSource] = useState<string | undefined>(embedded);
  useEffect(() => {
    let disposed = false;
    if (embedded?.startsWith('data:image/')) {
      setSource(embedded);
      return () => { disposed = true; };
    }
    setSource(undefined);
    if (!path) return () => { disposed = true; };
    void readLocalImage(path)
      .then((value) => { if (!disposed) setSource(value); })
      .catch(() => { if (!disposed) setSource(undefined); });
    return () => { disposed = true; };
  }, [embedded, path]);
  return source;
}

function AgentAvatar({ agentId, active = false }: { agentId: AgentId; active?: boolean }) {
  const agent = agentRoster.find((item) => item.id === agentId) ?? agentRoster[0];
  return <span className={`agent-avatar agent-${agentId} ${active ? 'active' : ''}`}>{agent.symbol}</span>;
}

function NodePreview({ node }: { node: AgentCanvasNode }) {
  const source = useLocalPreview(node.previewPath, node.previewDataUrl);
  if (source) return <img src={source} alt="" className="node-preview-image" />;
  if (node.kind === 'character') {
    return (
      <div className="node-character-placeholder">
        <span className="node-character-head" />
        <span className="node-character-body" />
      </div>
    );
  }
  if (node.kind === 'location') {
    return <div className="node-location-placeholder"><span /><span /><span /></div>;
  }
  if (node.kind === 'shot') {
    return <div className="node-scene-placeholder"><span /><span /><span /></div>;
  }
  return null;
}

function CanvasNode({ node, selected, onSelect }: { node: AgentCanvasNode; selected: boolean; onSelect: () => void }) {
  const Icon = nodeIcon(node.kind);
  const hasPreview = node.kind === 'character' || node.kind === 'location' || node.kind === 'shot';
  return (
    <button
      type="button"
      className={`canvas-node node-${node.kind} state-${node.status} ${selected ? 'selected' : ''}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onSelect(); }}
    >
      <div className="node-head">
        <span className="node-type"><Icon size={14} />{node.kind === 'shot' ? '分鏡鏡頭' : node.kind === 'location' ? '場景資產' : node.kind === 'character' ? '角色資產' : node.title}</span>
        <span className={`node-state state-${node.status}`}>{node.status === 'working' && <LoaderCircle size={11} className="spin" />}{agentStateLabel(node.status)}</span>
      </div>
      {hasPreview && <div className="node-preview"><NodePreview node={node} /></div>}
      <div className="node-copy">
        {hasPreview && <strong>{node.title}</strong>}
        <span>{node.subtitle}</span>
        {!hasPreview && node.detail && <p>{node.detail.slice(0, node.kind === 'script' ? 250 : 210)}</p>}
      </div>
      {node.status === 'working' && <span className="node-progress"><span style={{ width: `${Math.max(3, node.progress)}%` }} /></span>}
      {node.agentId && <span className="node-agent"><AgentAvatar agentId={node.agentId} />{agentRoster.find((agent) => agent.id === node.agentId)?.name}</span>}
    </button>
  );
}

function CanvasConnections({ nodes }: { nodes: AgentCanvasNode[] }) {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const pairs: Array<[string, string]> = [
    ['node_script', 'node_script_analysis'],
    ['node_script_analysis', 'node_art_direction'],
    ['node_script_analysis', 'node_ip_bible'],
    ['node_script_analysis', 'node_characters'],
    ['node_script_analysis', 'node_locations'],
    ['node_art_direction', 'node_characters'],
    ['node_art_direction', 'node_locations'],
    ['node_ip_bible', 'node_storyboard'],
    ['node_characters', 'node_storyboard'],
    ['node_locations', 'node_storyboard'],
    ['node_storyboard', 'node_sound'],
    ['node_storyboard', 'node_director_review'],
    ['node_sound', 'node_director_review'],
    ['node_director_review', 'node_render'],
  ];
  for (const node of nodes) {
    if (node.kind === 'character') pairs.push(['node_characters', node.id]);
    if (node.kind === 'location') pairs.push(['node_locations', node.id]);
    if (node.kind === 'shot') pairs.push(['node_storyboard', node.id]);
  }
  return (
    <svg className="canvas-links" width={canvasSize.width} height={canvasSize.height} aria-hidden="true">
      <defs>
        <linearGradient id="linkGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgba(255,255,255,.08)" />
          <stop offset="1" stopColor="rgba(255,255,255,.34)" />
        </linearGradient>
      </defs>
      {pairs.flatMap(([fromId, toId]) => {
        const from = map.get(fromId);
        const to = map.get(toId);
        if (!from || !to) return [];
        const x1 = from.x + from.width;
        const y1 = from.y + from.height / 2;
        const x2 = to.x;
        const y2 = to.y + to.height / 2;
        const bend = Math.max(70, Math.abs(x2 - x1) * .42);
        return [<path key={`${fromId}-${toId}`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />];
      })}
    </svg>
  );
}

function AgentSidebar({
  workspace,
  agentRuntime,
  onSend,
}: {
  workspace: AgentWorkspace;
  agentRuntime: AgentRuntimeProfile;
  onSend: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' });
  }, [workspace.messages.length]);
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
  };
  return (
    <aside className="agent-sidebar">
      <div className="agent-sidebar-head">
        <div><AgentAvatar agentId="director" active={workspace.activeAgentId === 'director'} /><span><strong>Evo Agent</strong><small>{workspace.autopilot ? '全自動導演模式' : '協作模式'}</small></span></div>
        <span className={`agent-brain-pill ${agentRuntime.available ? 'ready' : ''}`}><BrainCircuit size={13} />{agentRuntime.available ? 'Evolabs AI' : '安全備援'}</span>
      </div>
      <div className="agent-team-strip">
        {workspace.agents.map((agent) => (
          <div key={agent.id} className={`team-member ${workspace.activeAgentId === agent.id ? 'active' : ''}`} title={`${agent.name}・${agent.currentTask}`}>
            <AgentAvatar agentId={agent.id} active={workspace.activeAgentId === agent.id} />
            <span className={`team-state state-${agent.status}`} />
          </div>
        ))}
      </div>
      <div className="agent-conversation" ref={messagesRef}>
        {workspace.messages.map((item) => (
          <div className={`agent-message ${item.kind}`} key={item.id}>
            {item.agentId ? <AgentAvatar agentId={item.agentId} /> : <span className="user-message-avatar"><UserRound size={13} /></span>}
            <div><strong>{item.sender}</strong><p>{item.text}</p></div>
          </div>
        ))}
      </div>
      <div className="agent-roster">
        <div className="roster-title"><span>AI 製作團隊</span><em>{workspace.agents.filter((agent) => agent.status === 'done').length}/{workspace.agents.length}</em></div>
        {workspace.agents.map((agent) => (
          <div className={`roster-row ${workspace.activeAgentId === agent.id ? 'active' : ''}`} key={agent.id}>
            <AgentAvatar agentId={agent.id} active={workspace.activeAgentId === agent.id} />
            <span><strong>{agent.name}</strong><small>{agent.currentTask}</small></span>
            <em className={`state-${agent.status}`}>{agentStateLabel(agent.status)}</em>
          </div>
        ))}
      </div>
      <div className="agent-composer">
        <textarea
          value={value}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="給導演補充指令，例如：改成寫實、縮短到 30 秒…"
        />
        <button type="button" onClick={submit} aria-label="送出指令"><Rocket size={16} /></button>
      </div>
    </aside>
  );
}

function TaskDock({ workspace, install, render }: { workspace: AgentWorkspace; install: ModelInstallSnapshot | null; render: RenderJobSnapshot | null }) {
  const progress = render?.overallProgress ?? (install?.progress ?? workspaceOverallProgress(workspace));
  const activeTask = workspace.tasks.find((task) => task.state === 'working' || task.state === 'blocked')
    ?? [...workspace.tasks].reverse().find((task) => task.state === 'done')
    ?? workspace.tasks[0];
  return (
    <div className="task-dock">
      <div className="task-dock-icon">{workspace.state === 'completed' ? <Check size={18} /> : <Workflow size={18} />}</div>
      <div>
        <strong>{workspace.state === 'completed' ? '全自動任務完成' : activeTask?.title || '等待劇本'}</strong>
        <span>{install && !terminalInstall(install) ? install.message : render?.message || activeTask?.detail || '把劇本交給團隊'}</span>
        {(workspace.state !== 'idle' && workspace.state !== 'completed') && <span className="task-progress"><span style={{ width: `${Math.max(2, progress)}%` }} /></span>}
      </div>
      <em>{Math.round(progress)}%</em>
    </div>
  );
}

function ScriptLaunchCard({
  project,
  running,
  onChange,
  onStart,
  onExample,
}: {
  project: EvolabsProject;
  running: boolean;
  onChange: (value: string) => void;
  onStart: () => void;
  onExample: () => void;
}) {
  return (
    <div className="script-launch-card">
      <div className="launch-kicker"><Sparkles size={14} /> ONE SCRIPT → FULL FILM</div>
      <h1>你只負責劇本。<br />剩下交給 Evolabs 團隊。</h1>
      <p>Evo 導演會調度七位專業 Agent，自動完成劇本分析、視覺聖經、角色與場景資產、分鏡、聲音、生成與剪輯。你不需要逐頁設定。</p>
      <div className="launch-feature-grid">
        <span><BrainCircuit size={16} /><b>真實多 Agent</b><small>每位專家獨立交付，再由導演驗收</small></span>
        <span><ShieldCheck size={16} /><b>角色一致性</b><small>臉型、服裝、場景與連戲共享同一份聖經</small></span>
        <span><Gauge size={16} /><b>4GB 安全生成</b><small>逐鏡排程、快取重用、失敗只重做單鏡</small></span>
      </div>
      <div className="launch-editor">
        <textarea
          value={project.story}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
          placeholder="在這裡貼上完整劇本，或只寫故事構想……"
          spellCheck={false}
        />
        <div className="launch-editor-footer">
          <span><ShieldCheck size={13} /> 預設只在這台電腦處理</span>
          <button type="button" onClick={onExample}><WandSparkles size={14} /> 放入範例</button>
        </div>
      </div>
      <button className="launch-button" type="button" disabled={!project.story.trim() || running} onClick={onStart}>
        {running ? <><LoaderCircle size={18} className="spin" /> 團隊正在製作</> : <><Bot size={18} /> 交給 Evolabs 團隊</>}
      </button>
      <div className="launch-pipeline">
        {agentRoster.map((agent, index) => <span key={agent.id}><AgentAvatar agentId={agent.id} />{index < agentRoster.length - 1 && <i />}</span>)}
      </div>
    </div>
  );
}

function NodeInspector({ node, project, onClose }: { node: AgentCanvasNode; project: EvolabsProject; onClose: () => void }) {
  const character = node.characterId ? project.characters.find((item) => item.id === node.characterId) : undefined;
  const location = node.locationId ? project.productionBible?.locations?.find((item) => item.id === node.locationId) : undefined;
  const scene = node.sceneId ? project.scenes.find((item) => item.id === node.sceneId) : undefined;
  const preview = useLocalPreview(node.previewPath, node.previewDataUrl);
  return (
    <aside className="node-inspector">
      <div className="inspector-head"><span><strong>{node.title}</strong><small>{node.subtitle}</small></span><button type="button" onClick={onClose}><X size={16} /></button></div>
      {preview && <img className="inspector-preview" src={preview} alt="" />}
      <div className="inspector-section"><label>負責 Agent</label><div className="inspector-agent">{node.agentId && <AgentAvatar agentId={node.agentId} />}<span>{agentRoster.find((agent) => agent.id === node.agentId)?.name || 'Evo Agent'}</span></div></div>
      {character && <>
        <div className="inspector-section"><label>角色定位</label><p>{character.role}</p></div>
        <div className="inspector-section"><label>身份錨點</label><p>{character.identityAnchor || character.appearance}</p></div>
        <div className="inspector-section"><label>固定造型</label><p>{character.wardrobe || character.appearance}</p></div>
        <div className="inspector-section grid"><span><label>聲線</label><p>{character.voice}</p></span><span><label>一致性</label><p>{Math.round(character.consistencyStrength * 100)}%</p></span></div>
        {character.appearancePrompt && <div className="inspector-section"><label>角色生成提示</label><p>{character.appearancePrompt}</p></div>}
      </>}
      {location && <>
        <div className="inspector-section"><label>場景用途</label><p>{location.purpose}</p></div>
        <div className="inspector-section"><label>環境錨點</label><p>{location.environmentAnchor}</p></div>
        <div className="inspector-section grid"><span><label>時間／天氣</label><p>{location.timeOfDay}・{location.weather}</p></span><span><label>光線</label><p>{location.lighting}</p></span></div>
        <div className="inspector-section"><label>關鍵道具</label><p>{location.keyProps.join('、') || '無'}</p></div>
      </>}
      {scene && <>
        <div className="inspector-section"><label>決定性畫面</label><p>{scene.visual}</p></div>
        <div className="inspector-section"><label>動作與情緒</label><p>{[scene.action, scene.emotion].filter(Boolean).join('；') || '依劇本節點表演'}</p></div>
        <div className="inspector-section"><label>對白／旁白</label><p>{scene.dialogue || '無'}</p></div>
        <div className="inspector-section grid"><span><label>鏡頭</label><p>{scene.shot}</p></span><span><label>時長</label><p>{scene.duration} 秒</p></span></div>
        <div className="inspector-section"><label>首尾幀與運動</label><p>{scene.startFramePrompt || scene.visual}
→ {scene.endFramePrompt || scene.continuityOut || '承接下一鏡'}
運動：{scene.motionPrompt || scene.shot}</p></div>
        <div className="inspector-section"><label>連戲</label><p>{scene.continuityIn || '故事起始'} → {scene.continuityOut || '下一鏡'}</p></div>
      </>}
      {!character && !location && !scene && node.detail && <div className="inspector-section"><label>內容</label><p className="preserve-lines">{node.detail}</p></div>}
    </aside>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div className="settings-segmented">{options.map((option) => <button type="button" key={option.value} className={value === option.value ? 'active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function RuntimeSetupOverlay({
  snapshot,
  hardware,
  visualReady,
  visualInstall,
  visualLicenseAccepted,
  onRetry,
  onContinue,
  onPrepareVisual,
  onAcceptVisual,
}: {
  snapshot: RuntimeSetupSnapshot;
  hardware: HardwareProfile;
  visualReady: boolean;
  visualInstall: ModelInstallSnapshot | null;
  visualLicenseAccepted: boolean;
  onRetry: () => void;
  onContinue: () => void;
  onPrepareVisual: () => void;
  onAcceptVisual: () => void;
}) {
  const runtimeCompleted = snapshot.state === 'completed';
  const runtimeFailed = snapshot.state === 'failed';
  const visualWorking = Boolean(visualInstall && !terminalInstall(visualInstall));
  const visualFailed = visualInstall?.state === 'failed';
  const completed = runtimeCompleted && visualReady;
  const visualProgress = visualReady ? 100 : visualInstall?.progress ?? 0;
  const overallProgress = runtimeCompleted
    ? Math.min(100, 72 + visualProgress * .28)
    : Math.min(72, snapshot.progress * .72);
  const steps = [
    ...snapshot.steps,
    {
      id: 'visual-model',
      title: '準備 AI 視覺模型',
      state: visualReady ? 'done' : visualFailed ? 'failed' : visualWorking ? 'working' : runtimeCompleted ? 'queued' : 'queued',
      detail: visualReady
        ? '目前作品風格的本機生成模型已驗證'
        : visualWorking
          ? visualInstall?.message || `正在下載 ${Math.round(visualProgress)}%`
          : visualLicenseAccepted
            ? '等待下載並驗證動漫／寫實生成模型'
            : '首次使用需要在 Evolabs 內確認模型授權',
    },
  ] as Array<{ id: string; title: string; state: 'queued' | 'working' | 'done' | 'failed'; detail: string }>;
  const title = completed
    ? 'Evolabs AI Studio 已完全就緒'
    : runtimeCompleted
      ? visualWorking ? '正在準備高品質 AI 畫面' : '最後一步：準備視覺模型'
      : snapshot.title;
  const message = completed
    ? 'Agent 大腦、AI 畫面、Engine 與本機 API 都已完成。以後只要貼劇本。'
    : runtimeCompleted
      ? visualWorking
        ? '模型只下載一次；已完成的檔案會續傳與重用。'
        : '為了避免再輸出文字卡片，Evolabs 會安裝真正的動漫或寫實畫面模型。'
      : snapshot.message;
  return (
    <div className="runtime-setup-layer">
      <div className="runtime-setup-card">
        <section className="runtime-setup-hero">
          <div className="setup-brand"><Logo /><span>FIRST RUN</span></div>
          <div className={`setup-orbit ${completed ? 'completed' : runtimeFailed || visualFailed ? 'failed' : ''}`}>
            <span className="orbit-ring ring-one" />
            <span className="orbit-ring ring-two" />
            <span className="orbit-core"><BrainCircuit size={34} /></span>
            <span className="orbit-agent orbit-a">劇</span>
            <span className="orbit-agent orbit-b">角</span>
            <span className="orbit-agent orbit-c">鏡</span>
            <span className="orbit-agent orbit-d">聲</span>
          </div>
          <div className="setup-hero-copy">
            <span className="eyebrow">ONE-CLICK LOCAL STUDIO</span>
            <h1>{title}</h1>
            <p>{message}</p>
          </div>
          <div className="setup-hardware-card">
            <Cpu size={19} />
            <span><strong>{hardware.gpu}</strong><small>{hardware.vramMb ? `${(hardware.vramMb / 1024).toFixed(0)} GB VRAM · ${hardware.ramGb} GB RAM` : '自動偵測中'}</small></span>
            <em>{hardware.profile === 'rtx3050-4gb' ? '已套用 4GB 安全設定' : '自動最佳化'}</em>
          </div>
          <div className="setup-promises">
            <span><Check size={13} /> 不用安裝 LM Studio</span>
            <span><Check size={13} /> 不用設定 API 或模型路徑</span>
            <span><Check size={13} /> 完成後只要貼劇本</span>
          </div>
        </section>
        <section className="runtime-setup-progress-panel">
          <div className="setup-progress-head">
            <div><span>自動前置作業</span><strong>{Math.round(overallProgress)}%</strong></div>
            <div className="setup-progress-track"><span style={{ width: `${overallProgress}%` }} /></div>
          </div>
          <div className="setup-step-list">
            {steps.map((step, index) => (
              <div key={step.id} className={`setup-step state-${step.state}`}>
                <span className="setup-step-index">{step.state === 'done' ? <Check size={15} /> : step.state === 'working' ? <LoaderCircle size={15} className="spin" /> : step.state === 'failed' ? <X size={15} /> : index + 1}</span>
                <span><strong>{step.title}</strong><small>{step.detail}</small></span>
                <em>{step.state === 'done' ? '完成' : step.state === 'working' ? '處理中' : step.state === 'failed' ? '失敗' : '等待'}</em>
              </div>
            ))}
          </div>
          {snapshot.model && <div className="setup-model-pill"><BrainCircuit size={15} /><span><small>Agent model</small><strong>{snapshot.model}</strong></span><ShieldCheck size={16} /></div>}
          {runtimeFailed && <div className="setup-error"><X size={16} /><span><strong>Agent Runtime 自動修復未完成</strong><small>{snapshot.error || '請重新嘗試。'}</small></span></div>}
          {visualFailed && <div className="setup-error"><X size={16} /><span><strong>視覺模型準備失敗</strong><small>{visualInstall?.error || visualInstall?.message || '可以按下重新準備，已下載的部分會被保留。'}</small></span></div>}
          {runtimeCompleted && !visualReady && !visualLicenseAccepted && <div className="setup-license-note"><ShieldCheck size={16} /><span><strong>CreativeML Open RAIL-M</strong><small>模型授權需由你在 Evolabs 內確認一次，不需要離開程式。</small></span></div>}
          <div className="setup-actions">
            {(runtimeFailed || visualFailed) && <button type="button" className="secondary" onClick={onContinue}>先進入工作室</button>}
            <button
              type="button"
              className="primary"
              disabled={snapshot.state === 'running' || visualWorking}
              onClick={completed ? onContinue : runtimeFailed ? onRetry : runtimeCompleted && !visualLicenseAccepted ? onAcceptVisual : runtimeCompleted ? onPrepareVisual : onRetry}
            >
              {completed
                ? <><Rocket size={17} /> 進入 Evolabs</>
                : runtimeFailed
                  ? <><RefreshCw size={16} /> 自動修復</>
                  : visualWorking
                    ? <><LoaderCircle size={16} className="spin" /> 下載模型 {Math.round(visualProgress)}%</>
                    : runtimeCompleted && !visualLicenseAccepted
                      ? <><ShieldCheck size={16} /> 查看授權並自動安裝</>
                      : runtimeCompleted
                        ? <><Download size={16} /> 準備高品質畫面</>
                        : <><LoaderCircle size={16} className="spin" /> 正在準備</>}
            </button>
          </div>
          <p className="setup-footnote">下載時間取決於網路；已完成的元件會被重用，不會每次重新下載。</p>
        </section>
      </div>
    </div>
  );
}

function SettingsPanel({
  project,
  hardware,
  agentRuntime,
  updateInfo,
  modelInstall,
  onClose,
  onProjectChange,
  onRecheckHardware,
  onInstallModel,
  onCheckUpdate,
  onInstallUpdate,
}: {
  project: EvolabsProject;
  hardware: HardwareProfile;
  agentRuntime: AgentRuntimeProfile;
  updateInfo: AppUpdateInfo | null;
  modelInstall: ModelInstallSnapshot | null;
  onClose: () => void;
  onProjectChange: (project: EvolabsProject) => void;
  onRecheckHardware: () => void;
  onInstallModel: () => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const packs = hardware.modelPacks ?? [];
  const setSetting = <K extends keyof EvolabsProject['settings']>(key: K, value: EvolabsProject['settings'][K]) => {
    onProjectChange({ ...project, settings: { ...project.settings, [key]: value }, updatedAt: new Date().toISOString() });
  };
  return (
    <div className="panel-backdrop" onMouseDown={onClose}>
      <aside className="settings-panel" onMouseDown={(event: React.MouseEvent<HTMLElement>) => event.stopPropagation()}>
        <div className="settings-head"><div><span>EVOLABS</span><h2>工作室設定</h2></div><button type="button" onClick={onClose}><X size={18} /></button></div>
        <section><h3>全自動輸出</h3><label>作品風格</label><Segmented<ProjectMode> value={project.settings.mode} options={[{ value: 'anime', label: '動漫' }, { value: 'realistic', label: '寫實' }]} onChange={(value) => setSetting('mode', value)} /><label>成片比例</label><Segmented value={project.settings.format} options={[{ value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }, { value: '1:1', label: '1:1' }]} onChange={(value) => setSetting('format', value)} /><label>目標長度</label><Segmented value={String(project.settings.targetSeconds)} options={[{ value: '30', label: '30 秒' }, { value: '60', label: '60 秒' }, { value: '90', label: '90 秒' }]} onChange={(value) => setSetting('targetSeconds', Number(value))} /><label>品質</label><Segmented<QualityPreset> value={project.settings.quality} options={[{ value: 'speed', label: '快速' }, { value: 'balanced', label: '平衡' }, { value: 'cinema', label: '精緻' }]} onChange={(value) => setSetting('quality', value)} /></section>
        <section><div className="settings-section-head"><h3>AI Agent 大腦</h3><span className={agentRuntime.available ? 'good' : 'warning'}>{agentRuntime.available ? '自動管理中' : '安全備援'}</span></div><div className="system-card"><BrainCircuit size={18} /><span><strong>{agentRuntime.available ? agentRuntime.model : 'Evolabs 內建代理規劃器'}</strong><small>{agentRuntime.message}</small></span><button type="button" onClick={onRecheckHardware}><RefreshCw size={13} /> 自動修復</button></div><p className="settings-note">Evolabs 會自行安裝並管理 llmster、下載合適模型、啟動本機 API；你不需要另外開啟或設定 LM Studio。</p></section>
        <section><div className="settings-section-head"><h3>硬體與模型</h3><button type="button" onClick={onRecheckHardware}><RefreshCw size={13} /> 重新檢查</button></div><div className="system-card"><Cpu size={18} /><span><strong>{hardware.gpu}</strong><small>{hardware.vramMb ? `${Math.round(hardware.vramMb / 1024)} GB VRAM・${hardware.ramGb} GB RAM` : hardware.cpu}</small></span><em className={hardware.runtimeReady ? 'good' : 'warning'}>{hardware.runtimeReady ? '引擎就緒' : '需要修復'}</em></div><div className="model-list">{packs.map((pack) => <div key={pack.id}><span className={`model-dot ${pack.status}`} /><span><strong>{pack.name}</strong><small>{pack.message || pack.version || pack.status}</small></span><em>{pack.status === 'ready' ? '已就緒' : pack.status === 'unavailable' ? '不支援' : '未安裝'}</em></div>)}</div>{!aiImagesReady(project, hardware) && <button className="settings-primary" type="button" onClick={onInstallModel} disabled={Boolean(modelInstall && !terminalInstall(modelInstall))}>{modelInstall && !terminalInstall(modelInstall) ? `模型下載中 ${Math.round(modelInstall.progress)}%` : '安裝目前風格的 AI 畫面模型'}</button>}</section>
        <section><div className="settings-section-head"><h3>自動更新</h3><span className={updateInfo?.configured ? 'good' : 'warning'}>{updateInfo?.configured ? '已啟用' : '待首次綁定'}</span></div><div className="system-card"><Download size={18} /><span><strong>{updateInfo?.available ? `可更新至 ${updateInfo.version}` : `Evolabs ${updateInfo?.currentVersion || '0.6.0'}`}</strong><small>{updateInfo?.message || '檢查更新後會在程式內下載、安裝並重啟。'}</small></span></div><div className="settings-inline-actions"><button type="button" onClick={onCheckUpdate}><RefreshCw size={13} /> 檢查更新</button>{updateInfo?.available && <button className="settings-primary compact" type="button" onClick={onInstallUpdate}>更新並重啟</button>}</div><p className="settings-note">這版已改成簽章式自動更新架構。第一次發佈時綁定 GitHub Releases 或 Cloudflare R2；之後不用再手動替換 EXE 或執行建置器。</p></section>
        <div className="settings-footer">Evolabs 0.6.0 · Agent Studio · Self-managed runtime</div>
      </aside>
    </div>
  );
}

export default function App() {
  const [project, setProject] = useState<EvolabsProject>(() => createBlankProject());
  const [hardware, setHardware] = useState<HardwareProfile>(defaultHardware);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeProfile>(defaultAgentRuntime);
  const [runtimeSetup, setRuntimeSetup] = useState<RuntimeSetupSnapshot>(defaultRuntimeSetup);
  const [runtimeSetupVisible, setRuntimeSetupVisible] = useState(false);
  const [render, setRender] = useState<RenderJobSnapshot | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [modelInstall, setModelInstall] = useState<ModelInstallSnapshot | null>(null);
  const [activeInstallId, setActiveInstallId] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [licenseDialogOpen, setLicenseDialogOpen] = useState(false);
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pipelineError, setPipelineError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [canvasZoom, setCanvasZoom] = useState(.86);
  const [canvasPan, setCanvasPan] = useState({ x: 80, y: 30 });
  const projectRef = useRef(project);
  const runTokenRef = useRef(0);
  const productionStartingRef = useRef(false);
  const renderAfterInstallRef = useRef(false);
  const canvasDragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const demoMode = isDemoBridge();

  const commitProject = useCallback((next: EvolabsProject) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const mutateProject = useCallback((recipe: (current: EvolabsProject) => EvolabsProject) => {
    const next = recipe(projectRef.current);
    commitProject({ ...next, updatedAt: new Date().toISOString() });
  }, [commitProject]);

  const mutateWorkspace = useCallback((recipe: (workspace: AgentWorkspace) => AgentWorkspace) => {
    mutateProject((current) => ({ ...current, agentWorkspace: recipe(current.agentWorkspace ?? createAgentWorkspace(current)) }));
  }, [mutateProject]);

  useEffect(() => {
    let disposed = false;
    Promise.allSettled([loadProject(), getHardwareProfile(), getAgentRuntime(), getAiRuntimeSetup()]).then((results) => {
      if (disposed) return;
      const loaded = results[0].status === 'fulfilled' ? results[0].value : null;
      const hydratedProject = loaded
        ? { ...loaded, agentWorkspace: refreshScriptNode(loaded.agentWorkspace ?? createAgentWorkspace(loaded), loaded) }
        : projectRef.current;
      if (loaded) {
        commitProject(hydratedProject);
        try {
          const renderSession = JSON.parse(localStorage.getItem(renderSessionKey) || 'null') as { jobId?: unknown; projectId?: unknown } | null;
          if (renderSession?.projectId === loaded.id && typeof renderSession.jobId === 'string') setActiveJobId(renderSession.jobId);
        } catch { localStorage.removeItem(renderSessionKey); }
      }
      const hydratedHardware = results[1].status === 'fulfilled' ? results[1].value : defaultHardware;
      if (results[1].status === 'fulfilled') setHardware(hydratedHardware);
      if (results[2].status === 'fulfilled') setAgentRuntime(results[2].value);
      const setupSnapshot = results[3].status === 'fulfilled' ? results[3].value : defaultRuntimeSetup;
      setRuntimeSetup(setupSnapshot);
      const studioReady = setupSnapshot.state === 'completed' && aiImagesReady(hydratedProject, hydratedHardware);
      const firstRunComplete = localStorage.getItem('evolabs:runtime-setup-complete') === 'true' && studioReady;
      if (!demoMode) {
        setRuntimeSetupVisible(!firstRunComplete);
        void startAiRuntimeSetup(false).then(setRuntimeSetup).catch((error) => setRuntimeSetup({ ...defaultRuntimeSetup, state: 'failed', error: errorMessage(error), message: '自動準備失敗。' }));
      }
      try {
        const installSession = JSON.parse(localStorage.getItem(modelInstallSessionKey) || 'null') as { installId?: unknown; continueToRender?: unknown } | null;
        if (typeof installSession?.installId === 'string') {
          renderAfterInstallRef.current = installSession.continueToRender === true;
          setActiveInstallId(installSession.installId);
        }
      } catch { localStorage.removeItem(modelInstallSessionKey); }
      setHydrated(true);
    });
    const updateTimer = window.setTimeout(() => {
      void checkAppUpdate().then(setUpdateInfo).catch((error) => setUpdateInfo({ configured: false, available: false, currentVersion: '0.6.0', message: errorMessage(error) }));
    }, 1200);
    return () => { disposed = true; window.clearTimeout(updateTimer); };
  }, [commitProject, demoMode]);

  useEffect(() => {
    if (demoMode || !('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<RuntimeSetupSnapshot>('evolabs://runtime-setup', (event) => {
      if (disposed) return;
      setRuntimeSetup(event.payload);
      if (event.payload.state === 'completed') {
        void Promise.all([getHardwareProfile(), getAgentRuntime()]).then(([nextHardware, nextAgent]) => {
          if (disposed) return;
          setHardware(nextHardware);
          setAgentRuntime(nextAgent);
        });
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, [demoMode]);

  useEffect(() => {
    if (!hydrated) return;
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      void saveProject(projectRef.current)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 480);
    return () => window.clearTimeout(timer);
  }, [hydrated, project]);

  useEffect(() => {
    if (!hydrated || !('__TAURI_INTERNALS__' in window)) return;
    let closing = false;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      try {
        await saveProject(projectRef.current);
        if (disposed) return;
        closing = true;
        await appWindow.destroy();
      } catch { setSaveState('error'); }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [hydrated]);

  const beginRender = useCallback(async (snapshot: EvolabsProject) => {
    if (productionStartingRef.current || activeJobId) return;
    productionStartingRef.current = true;
    setPipelineError('');
    try {
      const result = await startRenderJob(snapshot, false);
      const queued: RenderJobSnapshot = {
        jobId: result.jobId,
        projectId: snapshot.id,
        scope: 'full',
        state: 'queued',
        stage: 'idle',
        overallProgress: 0,
        sceneProgress: 0,
        elapsedSeconds: 0,
        scenes: snapshot.scenes.map((scene) => ({ sceneId: scene.id, state: 'queued', progress: 0 })),
        message: 'Evo 導演正在建立生成排程…',
      };
      setRender(queued);
      setActiveJobId(result.jobId);
      localStorage.setItem(renderSessionKey, JSON.stringify({ jobId: result.jobId, projectId: snapshot.id }));
      mutateProject((current) => ({ ...current, agentWorkspace: syncWorkspaceWithRender(current.agentWorkspace ?? createAgentWorkspace(current), current, queued) }));
    } catch (error) {
      const message = errorMessage(error);
      setPipelineError(message);
      mutateWorkspace((workspace) => ({ ...workspace, state: 'failed', failure: message }));
    } finally {
      productionStartingRef.current = false;
    }
  }, [activeJobId, mutateProject, mutateWorkspace]);

  const installModelAndContinue = useCallback(async (continueToRender = true) => {
    const current = projectRef.current;
    renderAfterInstallRef.current = continueToRender;
    if (demoMode) {
      if (continueToRender && current.scenes.length > 0) await beginRender(current);
      return;
    }
    const refreshed = await getHardwareProfile().catch(() => hardware);
    setHardware(refreshed);
    if (aiImagesReady(current, refreshed)) {
      if (continueToRender && current.scenes.length > 0) await beginRender(current);
      return;
    }
    const accepted = localStorage.getItem(openRailAcceptedKey) === 'true';
    if (!accepted) {
      setLicenseAccepted(false);
      setLicenseDialogOpen(true);
      if (continueToRender) mutateWorkspace((workspace) => ({ ...workspace, state: 'preparing-models', activeAgentId: 'director' }));
      return;
    }
    const packId = requiredAiPackId(current, refreshed);
    if (continueToRender) {
      mutateWorkspace((workspace) => {
        const nodes = workspace.nodes.map((node) => node.kind === 'render' ? { ...node, status: 'blocked' as const, subtitle: '正在準備本機 AI 畫面模型' } : node);
        return setAgentPhase({ ...workspace, state: 'preparing-models', nodes }, 'director', 'working', 78, '準備本機 AI 畫面模型', '模型準備完成後會自動繼續，不需要重新操作。');
      });
    }
    try {
      const result = await startModelInstall(packId, [openRailLicenseId]);
      setActiveInstallId(result.installId);
      const queued: ModelInstallSnapshot = { installId: result.installId, packId, state: 'queued', progress: 0, downloadedBytes: 0, totalBytes: 0, message: '正在驗證模型來源…' };
      setModelInstall(queued);
      localStorage.setItem(modelInstallSessionKey, JSON.stringify({ installId: result.installId, packId, continueToRender }));
    } catch (error) {
      renderAfterInstallRef.current = false;
      const message = errorMessage(error);
      setPipelineError(message);
      if (continueToRender) mutateWorkspace((workspace) => ({ ...workspace, state: 'failed', failure: message }));
    }
  }, [beginRender, demoMode, hardware, mutateWorkspace]);

  const startAutopilot = useCallback(async () => {
    const source = projectRef.current;
    if (!source.story.trim()) return;

    const token = ++runTokenRef.current;
    setPipelineError('');
    setActionMessage('');
    setSelectedNodeId(null);
    setRender(null);
    setActiveJobId(null);
    localStorage.removeItem(renderSessionKey);

    const canReusePlan = source.plannedStoryFingerprint === planningFingerprint(source)
      && source.characters.length > 0
      && source.scenes.length > 0
      && Boolean(source.productionBible?.directorReview);
    if (canReusePlan) {
      const cachedPlan = productionPlan(
        source,
        source.productionBible ?? {},
        source.characters,
        source.scenes,
        'multi-agent',
      );
      let cachedWorkspace = applyPlanToWorkspace(
        createAgentWorkspace(source),
        source,
        cachedPlan,
        source.agentWorkspace?.provider,
        source.agentWorkspace?.providerModel,
      );
      cachedWorkspace = {
        ...cachedWorkspace,
        messages: [
          ...cachedWorkspace.messages,
          {
            id: createId('message'),
            sender: 'Evo 導演',
            agentId: 'director',
            kind: 'agent',
            createdAt: new Date().toISOString(),
            text: '劇本、設定與導演指令沒有改變。我已直接重用通過驗收的製作聖經與角色／場景資產，跳過重複規劃並進入生成。',
          },
        ],
      };
      const cachedProject: EvolabsProject = {
        ...source,
        settings: { ...source.settings, visualMode: 'ai-images', renderMode: 'film', autopilot: true, keepCharacterIdentity: true },
        agentWorkspace: cachedWorkspace,
        updatedAt: new Date().toISOString(),
      };
      commitProject(cachedProject);
      await saveProject(cachedProject).catch(() => undefined);
      await installModelAndContinue(true);
      return;
    }

    const freshWorkspace = createAgentWorkspace(source);
    let workspace: AgentWorkspace = {
      ...refreshScriptNode(freshWorkspace, source),
      runId: createId('agent_run'),
      state: 'planning',
      activeAgentId: 'screenwriter',
      startedAt: new Date().toISOString(),
      provider: 'fallback',
      messages: [
        ...freshWorkspace.messages,
        { id: createId('message'), sender: '你', text: '請把這份劇本直接做成完整短片，剩下全部交給團隊。', kind: 'user', createdAt: new Date().toISOString() },
      ],
    };
    let working: EvolabsProject = {
      ...source,
      settings: {
        ...source.settings,
        visualMode: 'ai-images',
        renderMode: 'film',
        autopilot: true,
        keepCharacterIdentity: true,
      },
      characters: [],
      scenes: [],
      productionBible: {},
      plannedStoryFingerprint: undefined,
      workflowStep: 0,
      maxUnlockedStep: 0,
      agentWorkspace: workspace,
      updatedAt: new Date().toISOString(),
    };
    commitProject(working);

    const fallback = createFallbackProduction(working);
    let bible: ProductionBible = {};
    let characters: EvolabsProject['characters'] = [];
    let scenes: Scene[] = [];
    let localStageCount = 0;
    let fallbackStageCount = 0;

    const runtime = await getAgentRuntime().catch(() => agentRuntime);
    setAgentRuntime(runtime);

    const ensureCurrentRun = () => {
      if (runTokenRef.current !== token) throw new Error('PIPELINE_REPLACED');
    };

    const publish = async (nextProject = working) => {
      working = { ...nextProject, agentWorkspace: workspace, updatedAt: new Date().toISOString() };
      commitProject(working);
      await saveProject(working).catch(() => undefined);
      ensureCurrentRun();
    };

    const beginStage = async (
      stage: AgentStage,
      progress: number,
      task: string,
      startMessage: string,
    ) => {
      const agentId = stage === 'director-review' ? 'director' : stage;
      workspace = setAgentPhase(workspace, agentId, 'working', progress, task, startMessage);
      await publish();
      await sleep(180);
    };

    const resolveStage = async <T,>(
      stage: AgentStage,
      context: unknown,
      fallbackValue: T,
      normalize: (value: unknown) => T,
    ): Promise<T> => {
      if (!runtime.available) {
        fallbackStageCount += 1;
        return fallbackValue;
      }
      try {
        const raw = await runAgentStage(stage, working, context);
        localStageCount += 1;
        return normalize(raw);
      } catch (error) {
        fallbackStageCount += 1;
        const agentId = stage === 'director-review' ? 'director' : stage;
        workspace = setAgentPhase(
          workspace,
          agentId,
          'working',
          Math.max(45, workspace.agents.find((agent) => agent.id === agentId)?.progress ?? 45),
          '本機模型回應異常，改用該階段的內建專家',
          `${agentRoster.find((agent) => agent.id === agentId)?.name || 'Agent'} 未能完成結構化交付：${errorMessage(error)}。此階段已自動改用 Evolabs 內建專家，不會中斷整部作品。`,
        );
        await publish();
        return fallbackValue;
      }
    };

    const completeStage = async (
      stage: AgentStage,
      completedMessage: string,
      nextProject: EvolabsProject,
    ) => {
      workspace = applyArtifactToWorkspace(workspace, nextProject, stage, bible, completedMessage);
      await publish({ ...nextProject, productionBible: bible });
      await sleep(140);
    };

    try {
      await beginStage('screenwriter', 12, '解析人物、衝突、節奏與故事節點', '我先把完整劇本拆成可供其他 Agent 共用的故事結構。');
      const script = await resolveStage(
        'screenwriter',
        { settings: working.settings },
        fallback.bible.script,
        (value) => normalizeScriptAnalysis(value, working),
      );
      bible = { ...bible, script };
      working = { ...working, title: script.title, productionBible: bible };
      await completeStage('screenwriter', `劇本拆解完成：${script.beats.length} 個故事節點、${script.characterSeeds.length} 個角色種子與 ${script.locationSeeds.length} 個場景需求。`, working);

      await beginStage('art-director', 24, '建立全片視覺聖經', '我正在把風格、色彩、材質、光線與攝影規則鎖成全片共用資產。');
      const artDirection = await resolveStage(
        'art-director',
        { script },
        fallback.bible.artDirection,
        (value) => normalizeArtDirection(value, working),
      );
      bible = { ...bible, artDirection };
      working = { ...working, productionBible: bible };
      await completeStage('art-director', `視覺聖經已建立：${artDirection.styleName}。後續角色、場景與分鏡都會繼承同一套視覺規則。`, working);

      await beginStage('ip-designer', 34, '鎖定世界觀與連戲規則', 'IP 設計師正在建立角色、服裝、場景、道具與光線不能漂移的規則。');
      const ipBible = await resolveStage(
        'ip-designer',
        { script, artDirection },
        fallback.bible.ipBible,
        (value) => normalizeIpBible(value, working, script),
      );
      bible = { ...bible, ipBible };
      working = { ...working, productionBible: bible };
      await completeStage('ip-designer', `IP／連戲聖經完成：${ipBible.worldRules.length} 條世界規則、${ipBible.continuityRules.length} 條連戲規則。`, working);

      await beginStage('character-designer', 45, '建立可重用角色資產', '角色設計師正在為每位人物建立身份錨點、固定服裝、表情規則與聲線。');
      characters = await resolveStage(
        'character-designer',
        { script, artDirection, ipBible },
        normalizeCharacters({}, working, script),
        (value) => normalizeCharacters(value, working, script),
      );
      working = { ...working, characters, productionBible: bible, workflowStep: 1, maxUnlockedStep: 1 };
      await completeStage('character-designer', `已建立 ${characters.length} 個角色資產；臉型、髮型、服裝、配件與聲線已鎖定供所有鏡頭重用。`, working);

      await beginStage('scene-designer', 57, '抽取並設計可重用場景資產', '場景設計師正在建立地點格局、時間、天氣、光線與關鍵道具。');
      const locations = await resolveStage(
        'scene-designer',
        { script, artDirection, ipBible, characters },
        normalizeLocations({}, working, script, artDirection),
        (value) => normalizeLocations(value, working, script, artDirection),
      );
      bible = { ...bible, locations };
      working = { ...working, characters, productionBible: bible, workflowStep: 2, maxUnlockedStep: 2 };
      await completeStage('scene-designer', `已建立 ${locations.length} 個可重用場景資產；同一地點不會在不同鏡頭隨機改格局或光線。`, working);

      await beginStage('storyboard-artist', 69, '拆分可生成鏡頭與首尾幀', '分鏡師正在把故事、角色與場景資產連成可生成的鏡頭序列。');
      scenes = await resolveStage(
        'storyboard-artist',
        { script, artDirection, ipBible, characters, locations },
        normalizeStoryboard({}, working, script, artDirection, characters, locations),
        (value) => normalizeStoryboard(value, working, script, artDirection, characters, locations),
      );
      working = {
        ...working,
        characters,
        scenes,
        productionBible: bible,
        workflowStep: 3,
        maxUnlockedStep: 3,
      };
      await completeStage('storyboard-artist', `分鏡完成：${scenes.length} 鏡，已包含構圖、決定性畫面、首尾幀、運鏡、台詞、轉場與前後連戲。`, working);

      await beginStage('sound-director', 79, '安排配音、環境音、音效與音樂', '聲音導演正在依每個鏡頭配置聲線、節奏、環境音與音樂走向。');
      const sound = await resolveStage(
        'sound-director',
        { script, artDirection, ipBible, characters, locations, scenes },
        normalizeSound({}, scenes, characters),
        (value) => normalizeSound(value, scenes, characters),
      );
      const soundByScene = new Map(sound.cues.map((cue) => [cue.sceneId, cue]));
      scenes = scenes.map((scene) => {
        const cue = soundByScene.get(scene.id);
        return cue ? { ...scene, musicCue: cue.musicCue, ambience: cue.ambience, soundEffects: cue.soundEffects } : scene;
      });
      bible = { ...bible, sound };
      working = { ...working, characters, scenes, productionBible: bible };
      await completeStage('sound-director', `聲音設計完成：${sound.cues.length} 個鏡頭 cue，配音、字幕、環境音、音效與音樂方向已加入製作藍圖。`, working);

      await beginStage('director-review', 89, '總導演檢查連戲與可生成性', '我正在進行最後驗收；若發現可修正問題，會先自動寫回鏡頭提示，不要求你逐項確認。');
      let directorReview = await resolveStage(
        'director-review',
        { productionBible: bible, characters, scenes },
        normalizeDirectorReview({}, scenes),
        (value) => normalizeDirectorReview(value, scenes),
      );

      const actionableIssues = directorReview.issues.filter((issue) => issue.sceneId && issue.fix.trim());
      if (actionableIssues.length) {
        const fixesByScene = new Map<string, string[]>();
        for (const issue of actionableIssues) {
          if (!issue.sceneId) continue;
          const current = fixesByScene.get(issue.sceneId) ?? [];
          current.push(issue.fix);
          fixesByScene.set(issue.sceneId, current);
        }
        scenes = scenes.map((scene) => {
          const fixes = fixesByScene.get(scene.id);
          if (!fixes?.length) return scene;
          const directive = fixes.join('；');
          return {
            ...scene,
            visual: `${scene.visual}\n導演修正：${directive}`,
            continuityOut: `${scene.continuityOut || ''}${scene.continuityOut ? '；' : ''}導演修正：${directive}`,
          };
        });
        working = { ...working, scenes };

        if (runtime.available) {
          try {
            const rawSecondReview = await runAgentStage('director-review', working, {
              productionBible: bible,
              characters,
              scenes,
              appliedFixes: actionableIssues,
            });
            directorReview = normalizeDirectorReview(rawSecondReview, scenes);
            localStageCount += 1;
          } catch {
            // The first review and applied corrections remain valid; rendering can continue in autopilot mode.
          }
        }
      }
      bible = { ...bible, directorReview };
      working = { ...working, characters, scenes, productionBible: bible };
      await completeStage(
        'director-review',
        directorReview.approved
          ? `總導演驗收通過：${directorReview.score}/100。現在開始自動準備模型與生成成片。`
          : `總導演已把 ${directorReview.issues.length} 項修正寫回鏡頭提示；以全自動模式繼續生成並保留警告。`,
        working,
      );

      const plan = productionPlan(working, bible, characters, scenes, localStageCount ? 'multi-agent' : 'fast-planner');
      const provider = localStageCount && fallbackStageCount ? 'hybrid' : localStageCount ? 'lm-studio' : 'fallback';
      workspace = applyPlanToWorkspace(workspace, working, plan, provider, localStageCount ? runtime.model : undefined);
      workspace = {
        ...workspace,
        provider,
        providerModel: localStageCount ? runtime.model : undefined,
        messages: [
          ...workspace.messages,
          {
            id: createId('message'),
            sender: 'Evo 導演',
            agentId: 'director',
            kind: 'agent',
            createdAt: new Date().toISOString(),
            text: localStageCount
              ? `真實多 Agent 流程完成：本機模型負責 ${localStageCount} 次專業交付${fallbackStageCount ? `，另有 ${fallbackStageCount} 個階段由內建專家接手` : ''}。現在不用再填任何表單。`
              : 'Evo 導演與七位專業 Agent 已用 Evolabs 內建代理完成全部製作藍圖。現在不用再填任何表單。',
          },
        ],
      };
      working = {
        ...working,
        title: plan.title,
        characters: plan.characters.map((character) => ({ ...character, locked: true })),
        scenes: plan.scenes,
        productionBible: bible,
        plannedStoryFingerprint: planningFingerprint(working),
        workflowStep: 3,
        maxUnlockedStep: 3,
        agentWorkspace: workspace,
        updatedAt: new Date().toISOString(),
      };
      commitProject(working);
      await saveProject(working).catch(() => undefined);
      ensureCurrentRun();
      await installModelAndContinue();
    } catch (error) {
      if (errorMessage(error) === 'PIPELINE_REPLACED') return;
      const message = errorMessage(error);
      setPipelineError(message);
      mutateWorkspace((current) => ({ ...current, state: 'failed', failure: message }));
    }
  }, [agentRuntime, commitProject, installModelAndContinue, mutateWorkspace]);

  useEffect(() => {
    if (!activeInstallId) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await getModelInstall(activeInstallId);
        if (disposed) return;
        setModelInstall(snapshot);
        mutateWorkspace((workspace) => {
          const nodes = workspace.nodes.map((node) => node.kind === 'render'
            ? { ...node, status: snapshot.state === 'failed' ? 'failed' as const : snapshot.state === 'completed' ? 'queued' as const : 'blocked' as const, progress: snapshot.progress, subtitle: snapshot.message || '準備 AI 模型' }
            : node);
          return { ...workspace, state: snapshot.state === 'failed' ? 'failed' : 'preparing-models', nodes, failure: snapshot.error };
        });
        if (snapshot.state === 'completed') {
          localStorage.removeItem(modelInstallSessionKey);
          setActiveInstallId(null);
          const refreshed = await getHardwareProfile();
          if (disposed) return;
          setHardware(refreshed);
          const shouldRender = renderAfterInstallRef.current && projectRef.current.scenes.length > 0;
          renderAfterInstallRef.current = false;
          if (shouldRender) {
            await beginRender(projectRef.current);
          } else {
            mutateWorkspace((workspace) => ({ ...workspace, state: 'idle', activeAgentId: undefined, failure: undefined }));
            setRuntimeSetupVisible(true);
          }
          return;
        }
        if (snapshot.state === 'failed' || snapshot.state === 'canceled') {
          localStorage.removeItem(modelInstallSessionKey);
          setActiveInstallId(null);
          renderAfterInstallRef.current = false;
          setPipelineError(snapshot.error || snapshot.message || '模型安裝未完成。');
          return;
        }
        timer = window.setTimeout(() => void poll(), 900);
      } catch (error) {
        if (disposed) return;
        setPipelineError(errorMessage(error));
        timer = window.setTimeout(() => void poll(), 1800);
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [activeInstallId, beginRender, mutateWorkspace]);

  useEffect(() => {
    if (!activeJobId) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await getRenderJob(activeJobId);
        if (disposed) return;
        if (snapshot.projectId !== projectRef.current.id) {
          setPipelineError('這個生成工作屬於另一個專案。');
          setActiveJobId(null);
          localStorage.removeItem(renderSessionKey);
          return;
        }
        setRender(snapshot);
        mutateProject((current) => {
          const scenes = mergeRenderSceneState(current.scenes, snapshot.scenes);
          const withScenes = scenes === current.scenes ? current : { ...current, scenes };
          return { ...withScenes, agentWorkspace: syncWorkspaceWithRender(withScenes.agentWorkspace ?? createAgentWorkspace(withScenes), withScenes, snapshot) };
        });
        if (!terminalRenderStates.has(snapshot.state)) {
          timer = window.setTimeout(() => void poll(), 700);
        } else {
          localStorage.removeItem(renderSessionKey);
          if (snapshot.state === 'failed') setPipelineError(snapshot.error?.message || snapshot.message || '生成失敗。');
        }
      } catch (error) {
        if (disposed) return;
        setPipelineError(errorMessage(error));
        timer = window.setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [activeJobId, mutateProject]);

  const workspace = project.agentWorkspace ?? createAgentWorkspace(project);
  const selectedNode = workspace.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const running = ['planning', 'preparing-models', 'rendering'].includes(workspace.state);
  const hasPlan = project.characters.length > 0 && project.scenes.length > 0;

  const changeStory = (story: string) => {
    if (running) return;
    mutateProject((current) => {
      const next = { ...current, story };
      return { ...next, agentWorkspace: refreshScriptNode(next.agentWorkspace ?? createAgentWorkspace(next), next) };
    });
  };

  const newProject = () => {
    runTokenRef.current += 1;
    setRender(null);
    setActiveJobId(null);
    setModelInstall(null);
    setActiveInstallId(null);
    setSelectedNodeId(null);
    localStorage.removeItem(renderSessionKey);
    localStorage.removeItem(modelInstallSessionKey);
    commitProject(createBlankProject());
  };

  const sendDirectorInstruction = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    mutateProject((current) => {
      const currentWorkspace = current.agentWorkspace ?? createAgentWorkspace(current);
      return {
        ...current,
        directorInstructions: [...new Set([...(current.directorInstructions ?? []), trimmed])].slice(-32),
        agentWorkspace: {
          ...currentWorkspace,
          messages: [
            ...currentWorkspace.messages,
            { id: createId('message'), sender: '你', text: trimmed, kind: 'user', createdAt: new Date().toISOString() },
            { id: createId('message'), sender: 'Evo 導演', agentId: 'director', text: running ? '收到。我會在目前安全邊界套用；不會破壞已完成的內容。' : '收到。按「交給團隊」後，我會把這項指示一起納入規劃。', kind: 'agent', createdAt: new Date().toISOString() },
          ],
        },
      };
    });
    const seconds = value.match(/(30|60|90)\s*秒/u)?.[1];
    const mode = value.includes('寫實') ? 'realistic' : value.includes('動漫') || value.includes('動畫') ? 'anime' : undefined;
    if (seconds || mode) mutateProject((current) => ({ ...current, settings: { ...current.settings, ...(seconds ? { targetSeconds: Number(seconds) } : {}), ...(mode ? { mode } : {}) } }));
  };

  const handleRenderControl = async (action: RenderControlAction) => {
    if (!activeJobId) return;
    try {
      await controlRenderJob(activeJobId, action);
      const snapshot = await getRenderJob(activeJobId);
      setRender(snapshot);
      mutateProject((current) => ({ ...current, agentWorkspace: syncWorkspaceWithRender(current.agentWorkspace ?? createAgentWorkspace(current), current, snapshot) }));
    } catch (error) { setPipelineError(errorMessage(error)); }
  };

  const handleRevealOutput = async () => {
    if (!activeJobId) return;
    try {
      const result = await revealRenderOutput(activeJobId);
      setActionMessage(result.ok ? '已在檔案總管中顯示成片。' : '無法開啟輸出位置。');
    } catch (error) { setActionMessage(errorMessage(error)); }
  };

  const handleHardwareRecheck = async () => {
    setActionMessage('正在自動修復本機 AI Studio…');
    setRuntimeSetupVisible(true);
    try {
      setRuntimeSetup(await startAiRuntimeSetup(true));
    } catch (error) { setActionMessage(errorMessage(error)); }
  };

  const handleRuntimeContinue = async () => {
    if (runtimeSetup.state === 'completed' && aiImagesReady(projectRef.current, hardware)) localStorage.setItem('evolabs:runtime-setup-complete', 'true');
    setRuntimeSetupVisible(false);
    const [nextHardware, nextAgent] = await Promise.all([getHardwareProfile(), getAgentRuntime()]);
    setHardware(nextHardware);
    setAgentRuntime(nextAgent);
  };

  const handleRuntimeRetry = async () => {
    setRuntimeSetupVisible(true);
    try { setRuntimeSetup(await startAiRuntimeSetup(true)); }
    catch (error) { setRuntimeSetup({ ...runtimeSetup, state: 'failed', error: errorMessage(error) }); }
  };

  const handleCheckUpdate = async () => {
    try { setUpdateInfo(await checkAppUpdate()); } catch (error) { setActionMessage(errorMessage(error)); }
  };

  const handleInstallUpdate = async () => {
    try { await installAppUpdate(); } catch (error) { setActionMessage(errorMessage(error)); }
  };

  const requestModelInstall = () => {
    renderAfterInstallRef.current = false;
    if (localStorage.getItem(openRailAcceptedKey) === 'true') void installModelAndContinue(false);
    else { setLicenseAccepted(false); setLicenseDialogOpen(true); }
  };

  const fitCanvas = () => {
    setCanvasZoom(hasPlan ? .72 : .86);
    setCanvasPan(hasPlan ? { x: 40, y: 45 } : { x: 140, y: 60 });
  };

  const onCanvasWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -.06 : .06;
    setCanvasZoom((value) => Math.max(.42, Math.min(1.25, Number((value + delta).toFixed(2)))));
  };

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.canvas-node')) return;
    canvasDragRef.current = { startX: event.clientX, startY: event.clientY, panX: canvasPan.x, panY: canvasPan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = canvasDragRef.current;
    if (!drag) return;
    setCanvasPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY });
  };

  const onCanvasPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    canvasDragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  const progress = render?.overallProgress ?? modelInstall?.progress ?? workspaceOverallProgress(workspace);
  const errorGuide = renderErrorGuidance(render?.error?.code);

  return (
    <div className="agent-app-shell">
      <header className="studio-topbar">
        <div className="topbar-left"><Logo /><button className="project-switcher" type="button"><span>{project.title || '未命名專案'}</span><ChevronDown size={14} /></button><button className="topbar-icon" type="button" onClick={newProject} title="新專案"><Plus size={17} /></button></div>
        <nav className="studio-tabs"><button className="active" type="button">總覽</button><button type="button" onClick={() => setSelectedNodeId('node_script')}>劇本</button><button type="button" disabled={!hasPlan} onClick={() => setSelectedNodeId(project.characters[0] ? `node_character_${project.characters[0].id}` : null)}>角色</button><button type="button" disabled={!hasPlan} onClick={() => setSelectedNodeId(project.productionBible?.locations?.[0] ? `node_location_${project.productionBible.locations[0].id}` : null)}>場景</button><button type="button" disabled={!hasPlan} onClick={() => setSelectedNodeId('node_storyboard')}>分鏡</button><button type="button" disabled={!render} onClick={() => setSelectedNodeId('node_render')}>成片</button></nav>
        <div className="topbar-actions"><span className={`save-indicator ${saveState}`}><i />{saveState === 'saved' ? '已儲存' : saveState === 'saving' ? '儲存中' : '儲存失敗'}</span>{updateInfo?.available && <button className="update-pill" type="button" onClick={() => setSettingsOpen(true)}><Download size={14} />更新 {updateInfo.version}</button>}<button className={`runtime-pill ${hardware.runtimeReady && agentRuntime.available ? 'ready' : ''}`} type="button" onClick={() => runtimeSetup.state === 'completed' ? setSettingsOpen(true) : setRuntimeSetupVisible(true)}><span />{runtimeSetup.state === 'running' ? `自動準備 ${Math.round(runtimeSetup.progress)}%` : hardware.runtimeReady && agentRuntime.available ? (aiImagesReady(project, hardware) ? 'AI Studio 就緒' : '視覺模型待準備') : 'AI Studio 需要修復'}<ChevronDown size={13} /></button><button className="topbar-icon" type="button" onClick={() => setSettingsOpen(true)}><Settings size={17} /></button></div>
      </header>

      <div className="studio-body">
        <AgentSidebar workspace={workspace} agentRuntime={agentRuntime} onSend={sendDirectorInstruction} />
        <main className="canvas-shell">
          <div className="canvas-toolbar"><div><button type="button" onClick={() => setCanvasZoom((value) => Math.min(1.25, value + .08))}><ZoomIn size={15} /></button><span>{Math.round(canvasZoom * 100)}%</span><button type="button" onClick={() => setCanvasZoom((value) => Math.max(.42, value - .08))}><ZoomOut size={15} /></button><button type="button" onClick={fitCanvas}><Focus size={15} /> 適合畫面</button></div><div className="canvas-status"><span className={`state-dot state-${workspace.state}`} />{workspace.state === 'idle' ? '等待劇本' : workspace.state === 'planning' ? 'Agent 正在規劃' : workspace.state === 'preparing-models' ? '準備 AI 模型' : workspace.state === 'rendering' ? `正在生成 ${Math.round(progress)}%` : workspace.state === 'completed' ? '成片完成' : workspace.state === 'failed' ? '需要處理' : '已暫停'}</div></div>
          <div className="infinite-canvas" onWheel={onCanvasWheel} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp} onClick={() => setSelectedNodeId(null)}>
            <div className="canvas-grid" />
            {!hasPlan && workspace.state === 'idle' && <ScriptLaunchCard project={project} running={running} onChange={changeStory} onStart={() => void startAutopilot()} onExample={() => changeStory(sampleStory)} />}
            {(hasPlan || workspace.state !== 'idle') && (
              <div className="canvas-world" style={{ width: canvasSize.width, height: canvasSize.height, transform: `translate(${canvasPan.x}px, ${canvasPan.y}px) scale(${canvasZoom})` }}>
                <CanvasConnections nodes={workspace.nodes} />
                {workspace.nodes.map((node) => <CanvasNode key={node.id} node={node} selected={selectedNodeId === node.id} onSelect={() => setSelectedNodeId(node.id)} />)}
              </div>
            )}
          </div>
          {selectedNode && <NodeInspector node={selectedNode} project={project} onClose={() => setSelectedNodeId(null)} />}
          <TaskDock workspace={workspace} install={modelInstall} render={render} />
          {running && <div className="render-controls"><button type="button" onClick={() => void handleRenderControl(render?.state === 'paused' ? 'resume' : 'pause')} disabled={!activeJobId}>{render?.state === 'paused' ? <CirclePlay size={18} /> : <CirclePause size={18} />}</button><span><strong>{render?.message || modelInstall?.message || 'Agent 團隊正在工作'}</strong><small>{render ? `${formatClock(render.elapsedSeconds)} · ${Math.round(render.overallProgress)}%` : modelInstall ? `${formatBytes(modelInstall.downloadedBytes)} / ${formatBytes(modelInstall.totalBytes)}` : '規劃中'}</small></span><button type="button" className="stop" onClick={() => activeJobId ? void handleRenderControl('cancel') : runTokenRef.current += 1}><Square size={15} /></button></div>}
          {workspace.state === 'completed' && <div className="completion-bar"><span className="completion-icon"><Check size={19} /></span><div><strong>成片已由 Agent 團隊完成</strong><small>{render?.outputPath ? render.outputPath.split(/[\\/]/u).at(-1) : '輸出已完成'}</small></div><button type="button" onClick={() => void handleRevealOutput()}><ExternalLink size={15} /> 開啟成片</button><button type="button" className="secondary" onClick={() => void startAutopilot()}><RefreshCw size={14} /> 重新製作</button></div>}
          {(pipelineError || actionMessage || errorGuide) && <div className={`studio-toast ${pipelineError ? 'error' : ''}`}><span>{pipelineError ? <X size={15} /> : <Check size={15} />}</span><div><strong>{errorGuide?.title || (pipelineError ? '製作暫停' : 'Evolabs')}</strong><p>{errorGuide?.message || pipelineError || actionMessage}</p></div><button type="button" onClick={() => { setPipelineError(''); setActionMessage(''); }}><X size={14} /></button></div>}
        </main>
      </div>

      {hydrated && runtimeSetupVisible && !demoMode && <RuntimeSetupOverlay
        snapshot={runtimeSetup}
        hardware={hardware}
        visualReady={aiImagesReady(project, hardware)}
        visualInstall={modelInstall}
        visualLicenseAccepted={localStorage.getItem(openRailAcceptedKey) === 'true'}
        onRetry={() => void handleRuntimeRetry()}
        onContinue={() => void handleRuntimeContinue()}
        onPrepareVisual={() => void installModelAndContinue(false)}
        onAcceptVisual={() => { renderAfterInstallRef.current = false; setLicenseAccepted(false); setLicenseDialogOpen(true); }}
      />}
      {settingsOpen && <SettingsPanel project={project} hardware={hardware} agentRuntime={agentRuntime} updateInfo={updateInfo} modelInstall={modelInstall} onClose={() => setSettingsOpen(false)} onProjectChange={commitProject} onRecheckHardware={() => void handleHardwareRecheck()} onInstallModel={requestModelInstall} onCheckUpdate={() => void handleCheckUpdate()} onInstallUpdate={() => void handleInstallUpdate()} />}
      {licenseDialogOpen && <div className="dialog-backdrop" onMouseDown={() => setLicenseDialogOpen(false)}><div className="license-dialog" onMouseDown={(event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation()}><span className="dialog-icon"><ShieldCheck size={20} /></span><h2>首次安裝 AI 畫面模型</h2><p>Evolabs 會自動下載目前風格所需的本機模型。模型採用 CreativeML Open RAIL-M 授權；這項確認只需做一次，之後每次只貼劇本即可。</p><label><input type="checkbox" checked={licenseAccepted} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setLicenseAccepted(event.target.checked)} /><span>我已閱讀並同意模型授權與使用限制</span></label><div className="license-link">{openRailLicenseUrl}</div><div className="dialog-actions"><button type="button" onClick={() => setLicenseDialogOpen(false)}>取消</button><button type="button" className="primary" disabled={!licenseAccepted} onClick={() => { const continueToRender = renderAfterInstallRef.current; localStorage.setItem(openRailAcceptedKey, 'true'); setLicenseDialogOpen(false); void installModelAndContinue(continueToRender); }}>同意並自動繼續</button></div></div></div>}
      {!hydrated && <div className="studio-loading"><Logo /><span><i /></span></div>}
    </div>
  );
}
