import {
  Bot,
  Check,
  Clapperboard,
  Cpu,
  FileText,
  Film,
  Settings,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentRoster,
  applyArtifactToWorkspace,
  createAgentWorkspace,
  refreshScriptNode,
  setAgentPhase,
  stageAgent,
} from './lib/agentPipeline';
import {
  checkAppUpdate,
  controlRenderJob,
  getAiRuntimeSetup,
  getHardwareProfile,
  getRenderJob,
  installAppUpdate,
  importReferenceAsset,
  loadProject,
  revealRenderOutput,
  reviewRenderScene,
  saveProject,
  startAiRuntimeSetup,
  startRenderJob,
} from './lib/bridge';
import { createId } from './lib/id';
import { buildAgentConversationHistory, isVisibleDialogueMessage } from './lib/agentConversation';
import { applyAgentProposal } from './lib/projectChanges';
import { getVideoPreflightIssue } from './lib/videoPreflight';
import {
  strictArtDirection,
  strictCharacters,
  strictDirectorReview,
  strictIpBible,
  strictLocations,
  strictScriptAnalysis,
  strictSound,
  strictStoryboard,
} from './lib/strictArtifacts';
import {
  clearVideoProvider,
  configureComfyUiProvider,
  getAgentModels,
  getVideoProviderStatus,
  runAgentConversation,
  runAgentStageV3,
  testAgentModel,
} from './lib/studioBridge';
import { createBlankProject, sampleStory } from './state/defaultProject';
import ModelsView from './studio/ModelsView';
import ProductionView from './studio/ProductionView';
import SettingsView from './studio/SettingsView';
import StartView from './studio/StartView';
import { Brand, StatusPill } from './studio/ui';
import type {
  AgentChangeProposal,
  AgentId,
  AgentMessage,
  AgentModelCatalog,
  AgentModelTestResult,
  AgentStage,
  AgentStageResponse,
  AgentTaskState,
  AgentWorkspace,
  AppUpdateInfo,
  ConversationTarget,
  EvolabsProject,
  HardwareProfile,
  ProductionBible,
  RenderControlAction,
  RenderJobSnapshot,
  RuntimeCapabilities,
  RuntimeSetupSnapshot,
  Scene,
  SystemActivityEvent,
  VideoProviderStatus,
} from './types';

const selectedModelKey = 'evolabs:selected-agent-model-v3';
const renderSessionKey = 'evolabs:render-session-v3';
const terminalRenderStates = new Set<RenderJobSnapshot['state']>(['completed', 'failed', 'canceled']);

type StudioView = 'start' | 'production' | 'models' | 'settings';
type WorkState = 'idle' | 'writer' | 'team' | 'chat' | 'video-provider';
type SaveState = 'saved' | 'saving' | 'error';

const noCapabilities: RuntimeCapabilities = {
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
  trueVideoGeneration: false,
  videoProviderConfigured: false,
};

const defaultHardware: HardwareProfile = {
  gpu: '正在偵測顯示卡',
  vramMb: 0,
  ramGb: 0,
  cpu: '正在偵測處理器',
  profile: 'low-vram',
  runtimeReady: false,
  aiReady: false,
  capabilities: noCapabilities,
};

const defaultCatalog: AgentModelCatalog = {
  available: false,
  provider: 'unavailable',
  models: [],
  message: '正在檢查本機 Agent 模型。',
};

const defaultVideoProvider: VideoProviderStatus = {
  configured: false,
  available: false,
  workflowValid: false,
  nodeCount: 0,
  capabilities: {
    textToVideo: false,
    imageToVideo: false,
    outputVideo: false,
    promptBinding: false,
    negativePromptBinding: false,
    seedBinding: false,
    dimensionsBinding: false,
    frameBinding: false,
    fpsBinding: false,
    inputImageBinding: false,
    outputPrefixBinding: false,
  },
  detectedModels: [],
  compatibility: 'unknown',
  message: '尚未設定真正的影片模型服務。',
};

const defaultRuntimeSetup: RuntimeSetupSnapshot = {
  state: 'idle',
  stage: 'system',
  progress: 0,
  title: '準備本機 AI 執行環境',
  message: '等待檢查。',
  updatedAtUnixMs: Date.now(),
  steps: [
    { id: 'system', title: '檢查電腦與核心', state: 'queued', detail: '等待開始' },
    { id: 'llmster', title: '啟動 Agent 服務', state: 'queued', detail: '等待開始' },
    { id: 'model', title: '準備 Agent 模型', state: 'queued', detail: '等待開始' },
    { id: 'load', title: '載入模型', state: 'queued', detail: '等待開始' },
    { id: 'verify', title: '驗證模型回覆', state: 'queued', detail: '等待開始' },
  ],
};

const defaultUpdate: AppUpdateInfo = {
  configured: false,
  available: false,
  currentVersion: '0.8.0-beta.1',
  message: '尚未檢查更新。',
};

const agentNames = new Map(agentRoster.map((agent) => [agent.id, agent.name]));
const productionStages: AgentStage[] = [
  'screenwriter',
  'art-director',
  'ip-designer',
  'character-designer',
  'scene-designer',
  'storyboard-artist',
  'sound-director',
  'director-review',
];
const stageByAgent = new Map<AgentId, AgentStage>(productionStages.map((stage) => [stageAgent[stage], stage]));

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '本機服務沒有回應。';
}

function acknowledgementIssue(response: Pick<AgentStageResponse, 'acknowledgement'>): string | null {
  const missing = response.acknowledgement.missingInformation.filter(Boolean);
  if (!response.acknowledgement.understoodTask) {
    return missing.length
      ? `尚未確認任務，並需要補充：${missing.join('；')}`
      : '尚未確認自己已理解這次任務；本次不得建立或修改任何交付物。';
  }
  return missing.length ? `需要補充：${missing.join('；')}` : null;
}

function now(): string {
  return new Date().toISOString();
}

function activeViewForProject(project: EvolabsProject): StudioView {
  return project.productionBible?.script || project.characters.length || project.scenes.length ? 'production' : 'start';
}

function userMessage(text: string, agentId?: AgentId, conversationTarget: ConversationTarget | undefined = agentId): AgentMessage {
  return { id: createId('message'), agentId, sender: '你', text, kind: 'user', createdAt: now(), conversationTarget };
}

function assistantMessage(
  agentId: AgentId,
  response: Pick<AgentStageResponse, 'assistantReply' | 'evidence'>,
  proposalId?: string,
  conversationTarget?: ConversationTarget,
): AgentMessage {
  return {
    id: createId('message'),
    agentId,
    sender: agentNames.get(agentId) ?? 'AI 製片成員',
    text: response.assistantReply,
    kind: 'assistant',
    createdAt: now(),
    evidence: response.evidence,
    proposalId,
    conversationTarget,
  };
}

function activityEvent(
  category: SystemActivityEvent['category'],
  level: SystemActivityEvent['level'],
  title: string,
  detail?: string,
  extra: Partial<SystemActivityEvent> = {},
): SystemActivityEvent {
  return { id: createId('activity'), category, level, title, detail, createdAt: now(), ...extra };
}

function ensureWorkspace(project: EvolabsProject): AgentWorkspace {
  const workspace = project.agentWorkspace ?? createAgentWorkspace(project);
  return {
    ...workspace,
    messages: workspace.messages.filter(isVisibleDialogueMessage),
    activities: workspace.activities ?? [],
    proposals: workspace.proposals ?? [],
    activeConversation: workspace.activeConversation ?? 'screenwriter',
  };
}

function updateWorkspace(project: EvolabsProject, updater: (workspace: AgentWorkspace) => AgentWorkspace): EvolabsProject {
  return { ...project, agentWorkspace: updater(ensureWorkspace(project)), updatedAt: now() };
}

function addActivity(project: EvolabsProject, event: SystemActivityEvent): EvolabsProject {
  return updateWorkspace(project, (workspace) => ({ ...workspace, activities: [...(workspace.activities ?? []), event].slice(-500) }));
}

function addDialogue(project: EvolabsProject, message: AgentMessage): EvolabsProject {
  if (!isVisibleDialogueMessage(message)) {
    throw new Error(message.kind === 'assistant'
      ? 'AI 回覆缺少完整模型要求證據，系統已拒絕將其寫入對話。'
      : '空白或不受支援的訊息不得寫入對話。');
  }
  return updateWorkspace(project, (workspace) => ({ ...workspace, messages: [...workspace.messages, message].slice(-500) }));
}

function setTask(
  project: EvolabsProject,
  agentId: AgentId,
  state: AgentTaskState,
  progress: number,
  detail: string,
  metadata: Partial<{ requestId: string; modelId: string; startedAt: string; finishedAt: string; failure: string }> = {},
): EvolabsProject {
  return updateWorkspace(project, (workspace) => {
    const next = setAgentPhase(workspace, agentId, state, progress, detail);
    return {
      ...next,
      tasks: next.tasks.map((task) => task.agentId === agentId ? { ...task, ...metadata } : task),
    };
  });
}

function stageContext(project: EvolabsProject, videoProvider: VideoProviderStatus): unknown {
  return {
    approvedProjectMemory: {
      script: project.productionBible?.script,
      artDirection: project.productionBible?.artDirection,
      ipBible: project.productionBible?.ipBible,
      characters: project.characters,
      locations: project.productionBible?.locations,
      scenes: project.scenes,
      sound: project.productionBible?.sound,
      directorReview: project.productionBible?.directorReview,
    },
    generationContract: {
      mainMode: project.settings.visualMode === 'ai-video' ? 'true-video-model' : 'motion-comic',
      staticImageMotionMayNotMasqueradeAsVideo: true,
      mandatoryHumanShotApproval: true,
      strictCharacterSafety: project.settings.strictCharacterSafety !== false,
      imageToVideoReferencePolicy: videoProvider.capabilities.inputImageBinding
        ? {
          required: true,
          supportedCharactersPerShot: 1,
          userSuppliedIdentityReferenceRequired: true,
          instruction: '每個鏡頭必須只包含一名角色，且該角色必須已有使用者匯入的身份參考圖；多人鏡頭必須拆分或改用支援多人參考的工作流。',
        }
        : {
          required: false,
          supportedCharactersPerShot: '由目前文字轉影片工作流決定',
          userSuppliedIdentityReferenceRequired: false,
        },
      videoProvider: {
        configured: videoProvider.configured,
        available: videoProvider.available,
        workflowName: videoProvider.workflowName,
        capabilities: videoProvider.capabilities,
        compatibility: videoProvider.compatibility,
      },
    },
  };
}

function mergeRenderScenes(scenes: Scene[], render: RenderJobSnapshot): Scene[] {
  const snapshots = new Map(render.scenes.map((scene) => [scene.sceneId, scene]));
  return scenes.map((scene) => {
    const snapshot = snapshots.get(scene.id);
    if (!snapshot) return scene;
    const status: Scene['status'] = snapshot.state === 'done'
      ? 'done'
      : snapshot.state === 'failed'
        ? 'failed'
        : snapshot.state === 'review'
          ? 'review'
          : snapshot.state === 'working'
            ? 'working'
            : 'queued';
    return {
      ...scene,
      status,
      progress: snapshot.progress,
      previewPath: snapshot.previewPath,
      visualSource: snapshot.visualSource,
      generationAttempt: snapshot.generationAttempt,
      reviewState: snapshot.reviewState,
      reviewFeedback: snapshot.reviewFeedback,
      qualityChecks: snapshot.qualityChecks,
    };
  });
}


function invalidateSceneAfterReferenceChange(scene: Scene): Scene {
  return {
    ...scene,
    status: 'ready',
    progress: 0,
    previewPath: undefined,
    visualSource: undefined,
    generationAttempt: 0,
    reviewState: 'pending',
    reviewFeedback: undefined,
    qualityChecks: [],
  };
}

export default function StudioApp() {
  const [project, setProject] = useState<EvolabsProject>(() => createBlankProject());
  const projectRef = useRef(project);
  const [view, setView] = useState<StudioView>('start');
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [workState, setWorkState] = useState<WorkState>('idle');
  const [catalog, setCatalog] = useState<AgentModelCatalog>(defaultCatalog);
  const [selectedModelId, setSelectedModelIdState] = useState(() => localStorage.getItem(selectedModelKey) || 'auto');
  const [modelTest, setModelTest] = useState<AgentModelTestResult | null>(null);
  const [testingModel, setTestingModel] = useState(false);
  const [hardware, setHardware] = useState<HardwareProfile>(defaultHardware);
  const [runtimeSetup, setRuntimeSetup] = useState<RuntimeSetupSnapshot>(defaultRuntimeSetup);
  const [videoProvider, setVideoProvider] = useState<VideoProviderStatus>(defaultVideoProvider);
  const [update, setUpdate] = useState<AppUpdateInfo>(defaultUpdate);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [render, setRender] = useState<RenderJobSnapshot | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<ConversationTarget>('screenwriter');
  const [notice, setNotice] = useState('');
  const [fatalError, setFatalError] = useState('');
  const runTokenRef = useRef(0);

  const commitProject = useCallback((next: EvolabsProject) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const mutateProject = useCallback((updater: (current: EvolabsProject) => EvolabsProject) => {
    const next = updater(projectRef.current);
    commitProject(next);
    return next;
  }, [commitProject]);

  const persistNow = useCallback(async (next: EvolabsProject) => {
    setSaveState('saving');
    try {
      await saveProject(next);
      setSaveState('saved');
    } catch (error) {
      setSaveState('error');
      setFatalError(`專案儲存失敗：${errorMessage(error)}`);
    }
  }, []);

  const refreshEnvironment = useCallback(async () => {
    setRefreshing(true);
    const [hardwareResult, catalogResult, runtimeResult, videoResult] = await Promise.allSettled([
      getHardwareProfile(),
      getAgentModels(),
      getAiRuntimeSetup(),
      getVideoProviderStatus(),
    ]);
    if (hardwareResult.status === 'fulfilled') setHardware(hardwareResult.value);
    if (catalogResult.status === 'fulfilled') {
      setCatalog(catalogResult.value);
      if (selectedModelId !== 'auto' && !catalogResult.value.models.some((model) => model.id === selectedModelId)) {
        setSelectedModelIdState('auto');
        localStorage.setItem(selectedModelKey, 'auto');
      }
    }
    if (runtimeResult.status === 'fulfilled') setRuntimeSetup(runtimeResult.value);
    if (videoResult.status === 'fulfilled') setVideoProvider(videoResult.value);
    setRefreshing(false);
  }, [selectedModelId]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const loaded = await loadProject();
        if (disposed) return;
        const next = loaded ?? createBlankProject();
        commitProject(next);
        setSelectedTarget(next.agentWorkspace?.activeConversation ?? 'screenwriter');
        setView(activeViewForProject(next));
      } catch (error) {
        if (!disposed) setFatalError(errorMessage(error));
      }
      try {
        const session = JSON.parse(localStorage.getItem(renderSessionKey) || 'null') as { jobId?: unknown } | null;
        if (typeof session?.jobId === 'string') setActiveJobId(session.jobId);
      } catch {
        localStorage.removeItem(renderSessionKey);
      }
      await refreshEnvironment();
      if (!disposed) setHydrated(true);
    })();
    return () => { disposed = true; };
  }, [commitProject, refreshEnvironment]);

  useEffect(() => {
    if (!hydrated || project.settings.autoSave === false) return;
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      void saveProject(project)
        .then(() => setSaveState('saved'))
        .catch((error) => {
          setSaveState('error');
          setFatalError(`專案儲存失敗：${errorMessage(error)}`);
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [hydrated, project]);

  useEffect(() => {
    if (!activeJobId) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await getRenderJob(activeJobId);
        if (disposed) return;
        if (snapshot.projectId !== projectRef.current.id) throw new Error('這個影片工作屬於另一個專案。');
        setRender(snapshot);
        mutateProject((current) => updateWorkspace(
          { ...current, scenes: mergeRenderScenes(current.scenes, snapshot) },
          (workspace) => ({
            ...workspace,
            state: snapshot.state === 'completed' ? 'completed' : snapshot.state === 'failed' || snapshot.state === 'canceled' ? 'failed' : 'rendering',
          }),
        ));
        if (terminalRenderStates.has(snapshot.state)) {
          setActiveJobId(null);
          localStorage.removeItem(renderSessionKey);
          if (snapshot.state === 'completed') setNotice('所有核准鏡頭已合併，成片完成。');
          if (snapshot.state === 'failed') setFatalError(snapshot.error?.message ?? snapshot.message ?? '影片生成失敗。');
          return;
        }
        timer = window.setTimeout(() => void poll(), snapshot.state === 'awaiting-review' ? 1200 : 750);
      } catch (error) {
        if (disposed) return;
        setFatalError(errorMessage(error));
        timer = window.setTimeout(() => void poll(), 1800);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeJobId, mutateProject]);

  useEffect(() => {
    if (runtimeSetup.state !== 'running') return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void getAiRuntimeSetup().then((snapshot) => {
        if (disposed) return;
        setRuntimeSetup(snapshot);
        if (snapshot.state !== 'running') {
          window.clearInterval(timer);
          void refreshEnvironment();
        }
      }).catch(() => undefined);
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refreshEnvironment, runtimeSetup.state]);

  const setSelectedModelId = useCallback((modelId: string) => {
    const normalized = modelId.trim() || 'auto';
    setSelectedModelIdState(normalized);
    localStorage.setItem(selectedModelKey, normalized);
    setModelTest(null);
    setNotice(normalized === 'auto' ? '已改為自動選擇 Agent 模型。' : `已選擇 Agent 模型：${normalized}`);
  }, []);

  const changeSetting = useCallback(<K extends keyof EvolabsProject['settings']>(key: K, value: EvolabsProject['settings'][K]) => {
    mutateProject((current) => ({
      ...current,
      settings: {
        ...current.settings,
        [key]: value,
        ...(key === 'visualMode' && value === 'ai-video' ? { manualShotApproval: true, lipSync: false } : {}),
      },
      productionBible: current.productionBible?.directorReview
        ? { ...current.productionBible, directorReview: undefined }
        : current.productionBible,
      updatedAt: now(),
    }));
  }, [mutateProject]);

  const changeStory = useCallback((story: string) => {
    runTokenRef.current += 1;
    const current = projectRef.current;
    const next: EvolabsProject = {
      ...current,
      story,
      title: '未命名專案',
      characters: [],
      scenes: [],
      productionBible: {},
      directorInstructions: [],
      plannedStoryFingerprint: undefined,
      workflowStep: 0,
      maxUnlockedStep: 0,
      updatedAt: now(),
    };
    next.agentWorkspace = refreshScriptNode(createAgentWorkspace(next), next);
    commitProject(next);
    setRender(null);
    setActiveJobId(null);
    localStorage.removeItem(renderSessionKey);
  }, [commitProject]);

  const resetProject = useCallback(() => {
    runTokenRef.current += 1;
    const blank = createBlankProject();
    commitProject(blank);
    setRender(null);
    setActiveJobId(null);
    setFatalError('');
    setNotice('已建立新的空白專案。');
    setView('start');
    localStorage.removeItem(renderSessionKey);
  }, [commitProject]);


  const importCharacterReference = useCallback(async (characterId: string, dataUrl: string, fileName: string) => {
    if (render && !terminalRenderStates.has(render.state)) throw new Error('影片生成進行中，不能更換角色身份參考圖。');
    const imported = await importReferenceAsset(dataUrl, fileName);
    const current = projectRef.current;
    const character = current.characters.find((entry) => entry.id === characterId);
    if (!character) throw new Error('找不到要更新的角色。');
    const nextCharacters = current.characters.map((entry) => entry.id === characterId ? {
      ...entry,
      referenceImagePath: imported.path,
      referenceImageDataUrl: imported.dataUrl,
      referenceImageName: imported.name,
    } : entry);
    const nextScenes = current.scenes.map((scene) => scene.characterIds.includes(characterId)
      ? invalidateSceneAfterReferenceChange(scene)
      : scene);
    let next: EvolabsProject = { ...current, characters: nextCharacters, scenes: nextScenes, updatedAt: now() };
    next = addActivity(next, activityEvent('storage', 'success', `已更新角色「${character.name}」身份參考圖`, `${imported.name} · ${(imported.bytes / 1024 / 1024).toFixed(1)} MB`, { agentId: 'character-designer' }));
    commitProject(next);
    await persistNow(next);
    setRender(null);
    setActiveJobId(null);
    localStorage.removeItem(renderSessionKey);
    setNotice(`角色「${character.name}」身份參考圖已匯入；相關鏡頭必須重新生成與審核。`);
  }, [commitProject, persistNow, render]);

  const clearCharacterReference = useCallback(async (characterId: string) => {
    if (render && !terminalRenderStates.has(render.state)) throw new Error('影片生成進行中，不能移除角色身份參考圖。');
    const current = projectRef.current;
    const character = current.characters.find((entry) => entry.id === characterId);
    if (!character) throw new Error('找不到要更新的角色。');
    const nextCharacters = current.characters.map((entry) => entry.id === characterId ? {
      ...entry,
      referenceImagePath: undefined,
      referenceImageDataUrl: undefined,
      referenceImageName: undefined,
    } : entry);
    const nextScenes = current.scenes.map((scene) => scene.characterIds.includes(characterId)
      ? invalidateSceneAfterReferenceChange(scene)
      : scene);
    let next: EvolabsProject = { ...current, characters: nextCharacters, scenes: nextScenes, updatedAt: now() };
    next = addActivity(next, activityEvent('storage', 'info', `已移除角色「${character.name}」身份參考圖`, undefined, { agentId: 'character-designer' }));
    commitProject(next);
    await persistNow(next);
    setRender(null);
    setActiveJobId(null);
    localStorage.removeItem(renderSessionKey);
    setNotice(`角色「${character.name}」身份參考圖已移除。`);
  }, [commitProject, persistNow, render]);

  const requireAgentRuntime = useCallback((): boolean => {
    if (!catalog.available || !catalog.models.length) {
      setFatalError(catalog.message || '本機 AI 執行環境未連線。');
      setView('models');
      return false;
    }
    if (selectedModelId !== 'auto' && !catalog.models.some((model) => model.id === selectedModelId)) {
      setFatalError(`模型「${selectedModelId}」目前沒有載入。`);
      setView('models');
      return false;
    }
    return true;
  }, [catalog, selectedModelId]);

  const submitToWriter = useCallback(async () => {
    const source = projectRef.current;
    const story = source.story.trim();
    if (story.length < 4) return setFatalError('請至少輸入 4 個字。');
    if (story.length > 100_000) return setFatalError('劇本超過 100,000 字上限。');
    if (!requireAgentRuntime()) return;
    const token = ++runTokenRef.current;
    setWorkState('writer');
    setFatalError('');
    setNotice('');
    setView('production');

    let working: EvolabsProject = {
      ...source,
      title: '編劇分析中',
      characters: [],
      scenes: [],
      productionBible: {},
      plannedStoryFingerprint: undefined,
      updatedAt: now(),
    };
    working.agentWorkspace = {
      ...createAgentWorkspace(working),
      runId: createId('agent_run'),
      state: 'planning',
      activeAgentId: 'screenwriter',
      activeConversation: 'screenwriter',
      startedAt: now(),
      provider: 'lm-studio',
      providerModel: selectedModelId === 'auto' ? catalog.selectedModel : selectedModelId,
    };
    working = addDialogue(working, userMessage(story, 'screenwriter'));
    working = setTask(working, 'screenwriter', 'working', 10, '正在呼叫編劇模型', { startedAt: now() });
    working = addActivity(working, activityEvent('agent', 'working', '已將劇本送交編劇', `模型：${selectedModelId === 'auto' ? catalog.selectedModel ?? '自動選擇' : selectedModelId}`, { agentId: 'screenwriter' }));
    commitProject(working);
    await persistNow(working);

    try {
      const response = await runAgentStageV3<unknown>('screenwriter', working, stageContext(working, videoProvider), selectedModelId);
      if (runTokenRef.current !== token) return;
      working = addDialogue(working, assistantMessage('screenwriter', response, undefined, 'screenwriter'));
      working = addActivity(working, activityEvent('validation', 'success', '編劇模型回覆已接收並通過外層契約', response.evidence.requestId, {
        agentId: 'screenwriter', requestId: response.evidence.requestId, modelId: response.evidence.modelId, durationMs: response.evidence.latencyMs,
      }));
      const acknowledgementFailure = acknowledgementIssue(response);
      if (acknowledgementFailure) {
        working = setTask(working, 'screenwriter', 'blocked', 35, '等待使用者補充或確認任務', {
          requestId: response.evidence.requestId, modelId: response.evidence.modelId, finishedAt: now(),
        });
        working = addActivity(working, activityEvent('validation', 'warning', '編劇尚未進入交付階段', acknowledgementFailure, {
          agentId: 'screenwriter', requestId: response.evidence.requestId, modelId: response.evidence.modelId, durationMs: response.evidence.latencyMs,
        }));
        working = updateWorkspace(working, (workspace) => ({ ...workspace, state: 'paused', failure: acknowledgementFailure }));
        commitProject(working);
        await persistNow(working);
        setFatalError(`編劇需要補充或確認：${acknowledgementFailure}`);
        return;
      }
      const script = strictScriptAnalysis(response.artifact);
      const bible: ProductionBible = { script };
      working = { ...working, title: script.title, productionBible: bible, updatedAt: now() };
      working = updateWorkspace(working, (workspace) => applyArtifactToWorkspace(workspace, working, 'screenwriter', bible));
      working = setTask(working, 'screenwriter', 'done', 100, '編劇交付已驗證', {
        requestId: response.evidence.requestId, modelId: response.evidence.modelId, finishedAt: now(),
      });
      commitProject(working);
      await persistNow(working);
      setNotice('編劇已完成真實模型交付。你可以先交流修改，再執行完整製片團隊。');
    } catch (error) {
      if (runTokenRef.current !== token) return;
      const message = errorMessage(error);
      working = setTask(working, 'screenwriter', 'failed', 10, '編劇模型執行失敗', { failure: message, finishedAt: now() });
      working = addActivity(working, activityEvent('agent', 'error', '編劇執行失敗', message, { agentId: 'screenwriter' }));
      working = updateWorkspace(working, (workspace) => ({ ...workspace, state: 'failed', failure: message }));
      commitProject(working);
      await persistNow(working);
      setFatalError(message);
    } finally {
      setWorkState('idle');
    }
  }, [catalog, commitProject, persistNow, requireAgentRuntime, selectedModelId, videoProvider]);

  const applyStageArtifact = useCallback((stage: AgentStage, response: AgentStageResponse<unknown>, current: EvolabsProject): EvolabsProject => {
    let next = current;
    let bible = current.productionBible ?? {};
    if (stage === 'screenwriter') {
      bible = { script: strictScriptAnalysis(response.artifact) };
      next = { ...next, characters: [], scenes: [] };
    } else {
      const script = bible.script;
      if (!script) throw new Error('缺少編劇交付，不能執行後續 Agent。');
      if (stage === 'art-director') {
        bible = { ...bible, artDirection: strictArtDirection(response.artifact), directorReview: undefined };
      } else if (stage === 'ip-designer') {
        bible = { ...bible, ipBible: strictIpBible(response.artifact), directorReview: undefined };
      } else if (stage === 'character-designer') {
        next = { ...next, characters: strictCharacters(response.artifact, script, current.settings.mode) };
        bible = { ...bible, directorReview: undefined };
      } else if (stage === 'scene-designer') {
        bible = { ...bible, locations: strictLocations(response.artifact, script), directorReview: undefined };
      } else if (stage === 'storyboard-artist') {
        next = { ...next, scenes: strictStoryboard(response.artifact, current, current.characters, bible.locations ?? []) };
        bible = { ...bible, directorReview: undefined };
      } else if (stage === 'sound-director') {
        bible = { ...bible, sound: strictSound(response.artifact, current.scenes), directorReview: undefined };
      } else if (stage === 'director-review') {
        bible = { ...bible, directorReview: strictDirectorReview(response.artifact, current.scenes) };
      }
    }
    next = { ...next, productionBible: bible, updatedAt: now() };
    next = updateWorkspace(next, (workspace) => applyArtifactToWorkspace(workspace, next, stage, bible));
    return next;
  }, []);

  const runTeam = useCallback(async () => {
    if (!requireAgentRuntime()) return;
    let working = projectRef.current;
    if (!working.productionBible?.script) return setFatalError('請先把劇本送交編劇。');
    if (working.settings.visualMode === 'ai-video' && !videoProvider.available) {
      setFatalError(videoProvider.error ?? videoProvider.message);
      setView('models');
      return;
    }
    const token = ++runTokenRef.current;
    const maximumCorrectionRounds = 2;
    let correctionRound = 0;
    let startIndex = 1; // 編劇已由「交給編劇」完成；只有導演退件時才可能重跑。
    setWorkState('team');
    setFatalError('');
    setNotice('');
    setView('production');

    const executeStage = async (stage: AgentStage): Promise<void> => {
      if (runTokenRef.current !== token) throw new Error('製作流程已被新的工作取代。');
      const agentId = stageAgent[stage];
      const startedAt = now();
      working = setTask(working, agentId, 'working', 8, '正在呼叫真實模型', { startedAt });
      working = addActivity(working, activityEvent('agent', 'working', `${agentNames.get(agentId)}開始執行`, `專業階段：${stage}`, { agentId }));
      commitProject(working);
      await persistNow(working);

      const response = await runAgentStageV3<unknown>(stage, working, stageContext(working, videoProvider), selectedModelId);
      if (runTokenRef.current !== token) throw new Error('製作流程已被新的工作取代。');
      working = addDialogue(working, assistantMessage(agentId, response, undefined, agentId));
      working = addActivity(working, activityEvent('validation', 'success', `${agentNames.get(agentId)}回覆已通過外層契約`, response.evidence.requestId, {
        agentId,
        requestId: response.evidence.requestId,
        modelId: response.evidence.modelId,
        durationMs: response.evidence.latencyMs,
      }));
      const acknowledgementFailure = acknowledgementIssue(response);
      if (acknowledgementFailure) {
        working = setTask(working, agentId, 'blocked', 35, '等待使用者補充或確認任務', {
          requestId: response.evidence.requestId,
          modelId: response.evidence.modelId,
          finishedAt: now(),
        });
        working = addActivity(working, activityEvent('validation', 'warning', `${agentNames.get(agentId)}尚未進入交付階段`, acknowledgementFailure, {
          agentId, requestId: response.evidence.requestId, modelId: response.evidence.modelId, durationMs: response.evidence.latencyMs,
        }));
        working = updateWorkspace(working, (workspace) => ({ ...workspace, state: 'paused', activeAgentId: agentId, failure: acknowledgementFailure }));
        commitProject(working);
        await persistNow(working);
        throw new Error(`${agentNames.get(agentId)}需要補充或確認：${acknowledgementFailure}`);
      }
      working = applyStageArtifact(stage, response, working);
      working = setTask(working, agentId, 'done', 100, '模型交付已解析並驗證', {
        requestId: response.evidence.requestId,
        modelId: response.evidence.modelId,
        finishedAt: now(),
      });
      commitProject(working);
      await persistNow(working);
    };

    try {
      while (true) {
        for (let index = startIndex; index < productionStages.length; index += 1) {
          await executeStage(productionStages[index]);
        }

        const review = working.productionBible?.directorReview;
        if (review?.approved) {
          working = updateWorkspace(working, (workspace) => ({
            ...workspace,
            state: 'preparing-models',
            activeAgentId: undefined,
            finishedAt: now(),
          }));
          commitProject(working);
          await persistNow(working);
          setNotice(correctionRound
            ? `製片團隊已完成 ${correctionRound} 輪真實模型修正並通過總導演驗收。`
            : '製片團隊交付已完成並通過總導演驗收。');
          return;
        }

        if (!review) throw new Error('總導演沒有交付可驗證的驗收結果。');
        const blockingIssues = review.issues.filter((issue) => issue.severity !== 'info');
        const returnedStages = blockingIssues
          .map((issue) => issue.returnToAgent ? stageByAgent.get(issue.returnToAgent) : undefined)
          .filter((stage): stage is AgentStage => Boolean(stage && stage !== 'director-review'));
        if (!returnedStages.length) {
          throw new Error(`總導演未核准，但沒有指出可執行的退回階段：${review.summary}`);
        }
        if (correctionRound >= maximumCorrectionRounds) {
          throw new Error(`總導演在 ${maximumCorrectionRounds} 輪修正後仍未核准：${review.summary}`);
        }

        const earliest = Math.min(...returnedStages.map((stage) => productionStages.indexOf(stage)));
        const rerunStages = productionStages.slice(earliest);
        const correctionInstructions = blockingIssues.map((issue, issueIndex) => {
          const destination = issue.returnToAgent ? agentNames.get(issue.returnToAgent) ?? issue.returnToAgent : '相關 Agent';
          return `第 ${correctionRound + 1} 輪總導演退件 ${issueIndex + 1}（交回 ${destination}）：${issue.message}。修正要求：${issue.fix}`;
        });
        correctionRound += 1;
        startIndex = earliest;
        const mergedInstructions = [...(working.directorInstructions ?? []), ...correctionInstructions].slice(-32);
        working = {
          ...working,
          directorInstructions: mergedInstructions,
          productionBible: working.productionBible ? { ...working.productionBible, directorReview: undefined } : working.productionBible,
          updatedAt: now(),
        };
        working = updateWorkspace(working, (workspace) => ({
          ...workspace,
          state: 'planning',
          activeAgentId: stageAgent[productionStages[startIndex]],
          tasks: workspace.tasks.map((task) => rerunStages.some((stage) => stageAgent[stage] === task.agentId)
            ? { ...task, state: 'queued', progress: 0, failure: undefined, requestId: undefined, startedAt: undefined, finishedAt: undefined }
            : task),
        }));
        working = addActivity(working, activityEvent(
          'validation',
          'warning',
          `總導演退回第 ${correctionRound} 輪修正`,
          `將從「${agentNames.get(stageAgent[productionStages[startIndex]])}」重新執行到總導演驗收。`,
          { agentId: 'director' },
        ));
        commitProject(working);
        await persistNow(working);
      }
    } catch (error) {
      const message = errorMessage(error);
      const activeAgent = ensureWorkspace(working).activeAgentId ?? 'director';
      const needsUserInput = message.includes('需要補充或確認：');
      if (!needsUserInput) {
        working = setTask(working, activeAgent, 'failed', 15, '模型交付無法驗證', { failure: message, finishedAt: now() });
        working = addActivity(working, activityEvent('validation', 'error', 'AI 交付已停止', message, { agentId: activeAgent }));
        working = updateWorkspace(working, (workspace) => ({ ...workspace, state: 'failed', failure: message }));
        commitProject(working);
        await persistNow(working);
      }
      setFatalError(message);
    } finally {
      setWorkState('idle');
    }
  }, [applyStageArtifact, commitProject, persistNow, requireAgentRuntime, selectedModelId, videoProvider]);

  const sendMessage = useCallback(async (target: ConversationTarget, text: string) => {
    if (!requireAgentRuntime()) throw new Error('本機 AI 執行環境未連線。');
    setWorkState('chat');
    setFatalError('');
    let working = projectRef.current;
    const currentUserMessage = userMessage(text, target === 'production-meeting' ? undefined : target, target);
    working = addDialogue(working, currentUserMessage);
    working = updateWorkspace(working, (workspace) => ({ ...workspace, activeConversation: target }));
    commitProject(working);
    await persistNow(working);

    const participants: AgentId[] = target === 'production-meeting'
      ? agentRoster.map((agent) => agent.id)
      : [target];
    try {
      for (const agentId of participants) {
        const history = buildAgentConversationHistory(
          ensureWorkspace(working).messages,
          target,
          currentUserMessage.id,
        );
        working = addActivity(working, activityEvent('agent', 'working', `正在等待${agentNames.get(agentId)}回覆`, undefined, { agentId }));
        commitProject(working);
        const response = await runAgentConversation(agentId, text, stageContext(working, videoProvider), history, selectedModelId);
        const acknowledgementFailure = acknowledgementIssue(response);
        if (acknowledgementFailure && response.proposal) {
          throw new Error(`${agentNames.get(agentId)}在尚未確認任務或資訊不足時提出了修改提案；系統已拒絕。`);
        }
        let proposalId: string | undefined;
        if (!acknowledgementFailure && response.proposal) {
          proposalId = createId('proposal');
          const proposal: AgentChangeProposal = {
            ...response.proposal,
            id: proposalId,
            agentId,
            status: 'pending',
            createdAt: now(),
          };
          working = updateWorkspace(working, (workspace) => ({ ...workspace, proposals: [...(workspace.proposals ?? []), proposal].slice(-200) }));
        }
        working = addDialogue(working, assistantMessage(agentId, response, proposalId, target));
        working = addActivity(working, activityEvent('agent', acknowledgementFailure ? 'warning' : 'success',
          acknowledgementFailure ? `${agentNames.get(agentId)}需要補充或確認` : `${agentNames.get(agentId)}已回覆`,
          acknowledgementFailure ?? response.evidence.requestId, {
            agentId, requestId: response.evidence.requestId, modelId: response.evidence.modelId, durationMs: response.evidence.latencyMs,
          }));
        if (acknowledgementFailure) setNotice(`${agentNames.get(agentId)}：${acknowledgementFailure}`);
        commitProject(working);
        await persistNow(working);
      }
    } catch (error) {
      const message = errorMessage(error);
      working = addActivity(working, activityEvent('agent', 'error', 'AI 對話失敗', message));
      commitProject(working);
      await persistNow(working);
      setFatalError(message);
      throw error;
    } finally {
      setWorkState('idle');
    }
  }, [commitProject, persistNow, requireAgentRuntime, selectedModelId, videoProvider]);

  const applyProposal = useCallback((proposalId: string) => {
    if (render && !terminalRenderStates.has(render.state)) {
      setFatalError('影片生成進行中，不能套用會改變角色或鏡頭的 AI 修改。請先停止目前工作。');
      return;
    }
    try {
      mutateProject((current) => {
        const workspace = ensureWorkspace(current);
        const proposal = (workspace.proposals ?? []).find((entry) => entry.id === proposalId);
        if (!proposal || proposal.status !== 'pending') return current;
        const changed = applyAgentProposal(current, proposal);
        return updateWorkspace(changed, (nextWorkspace) => ({
          ...nextWorkspace,
          proposals: (nextWorkspace.proposals ?? []).map((entry) => entry.id === proposalId ? { ...entry, status: 'applied' } : entry),
          activities: [...(nextWorkspace.activities ?? []), activityEvent('storage', 'success', 'AI 修改提案已套用至專案', proposal.summary, { agentId: proposal.agentId })],
        }));
      });
      setRender(null);
      setActiveJobId(null);
      localStorage.removeItem(renderSessionKey);
      setNotice('AI 修改已套用；總導演核准已失效，請重新執行製片團隊。');
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }, [mutateProject, render]);

  const rejectProposal = useCallback((proposalId: string) => {
    mutateProject((current) => updateWorkspace(current, (workspace) => ({
      ...workspace,
      proposals: (workspace.proposals ?? []).map((entry) => entry.id === proposalId ? { ...entry, status: 'rejected' } : entry),
    })));
  }, [mutateProject]);

  const startVideo = useCallback(async () => {
    const current = projectRef.current;
    if (!current.productionBible?.directorReview?.approved) return setFatalError('總導演尚未核准製作聖經與分鏡。');
    if (!current.scenes.length) return setFatalError('尚未建立影片鏡頭。');
    if (current.settings.visualMode === 'ai-video' && !videoProvider.available) {
      setView('models');
      return setFatalError(videoProvider.error ?? videoProvider.message);
    }
    if (current.settings.visualMode === 'ai-video' && current.settings.lipSync) {
      return setFatalError('真正影片模式目前尚未提供可驗證的本機口型同步。請先在設定中關閉。');
    }
    const preflightIssue = getVideoPreflightIssue(current, videoProvider);
    if (preflightIssue) return setFatalError(preflightIssue);
    setFatalError('');
    try {
      const result = await startRenderJob(current, false);
      setActiveJobId(result.jobId);
      localStorage.setItem(renderSessionKey, JSON.stringify({ jobId: result.jobId, projectId: current.id }));
      const next = addActivity(current, activityEvent('video', 'working', '已建立影片生成工作', `工作識別碼：${result.jobId}`));
      commitProject(next);
      await persistNow(next);
      setView('production');
      setNotice(current.settings.visualMode === 'ai-video'
        ? '影片模型工作已開始；每個鏡頭完成後都必須由你核准。'
        : '動態漫畫工作已開始；此模式不會標示為影片模型生成。');
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }, [commitProject, persistNow, videoProvider]);

  const controlVideo = useCallback(async (action: RenderControlAction) => {
    if (!activeJobId) return;
    try {
      await controlRenderJob(activeJobId, action);
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }, [activeJobId]);

  const reviewScene = useCallback(async (sceneId: string, approved: boolean, feedback: string) => {
    if (!activeJobId) throw new Error('目前沒有等待審核的影片工作。');
    try {
      await reviewRenderScene(activeJobId, sceneId, approved, feedback);
      setNotice(approved ? '已核准此鏡頭，引擎將繼續。' : '已退回此鏡頭，引擎會依意見重新生成。');
    } catch (error) {
      setFatalError(errorMessage(error));
      throw error;
    }
  }, [activeJobId]);

  const revealOutput = useCallback(async () => {
    if (!render?.jobId) return;
    try {
      await revealRenderOutput(render.jobId);
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }, [render?.jobId]);

  const repairRuntime = useCallback(async () => {
    setFatalError('');
    try {
      const snapshot = await startAiRuntimeSetup(true);
      setRuntimeSetup(snapshot);
      setNotice('本機 AI 執行環境修復流程已開始。');
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }, []);

  const runModelTest = useCallback(async () => {
    setTestingModel(true);
    setModelTest(null);
    setFatalError('');
    try {
      const result = await testAgentModel(selectedModelId);
      setModelTest(result);
      setNotice(result.message);
    } catch (error) {
      setFatalError(errorMessage(error));
    } finally {
      setTestingModel(false);
    }
  }, [selectedModelId]);

  const configureVideo = useCallback(async (endpoint: string, workflowName: string, workflow: unknown) => {
    setWorkState('video-provider');
    setFatalError('');
    try {
      const status = await configureComfyUiProvider(endpoint, workflowName, workflow);
      setVideoProvider(status);
      setNotice('ComfyUI 影片工作流已通過連線、必要參數綁定、節點註冊與影片輸出節點驗證。真正生成能力會在第一個鏡頭工作中確認。');
    } catch (error) {
      setFatalError(errorMessage(error));
      throw error;
    } finally {
      setWorkState('idle');
    }
  }, []);

  const clearVideo = useCallback(async () => {
    try {
      await clearVideoProvider();
      setVideoProvider(await getVideoProviderStatus());
      setNotice('影片模型服務設定已清除。');
    } catch (error) {
      setFatalError(errorMessage(error));
      throw error;
    }
  }, []);

  const checkUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      const result = await checkAppUpdate();
      setUpdate(result);
      setNotice(result.message);
    } catch (error) {
      setFatalError(errorMessage(error));
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setInstallingUpdate(true);
    try {
      const result = await installAppUpdate();
      setNotice(result.message);
    } catch (error) {
      setFatalError(errorMessage(error));
    } finally {
      setInstallingUpdate(false);
    }
  }, []);

  const videoPreflightIssue = useMemo(() => getVideoPreflightIssue(project, videoProvider), [project, videoProvider]);

  const canRunTeam = Boolean(
    project.productionBible?.script
    && catalog.available
    && workState === 'idle'
    && (project.settings.visualMode !== 'ai-video' || videoProvider.available),
  );
  const canRender = Boolean(
    project.productionBible?.directorReview?.approved
    && project.scenes.length
    && workState === 'idle'
    && (project.settings.visualMode !== 'ai-video' || videoProvider.available)
    && !(project.settings.visualMode === 'ai-video' && project.settings.lipSync)
    && !videoPreflightIssue,
  );
  const renderBlockedReason = useMemo(() => {
    if (!project.productionBible?.directorReview?.approved) return '總導演尚未核准完整製作交付。';
    if (!project.scenes.length) return '尚未建立影片鏡頭。';
    if (project.settings.visualMode === 'ai-video' && !videoProvider.available) return videoProvider.error ?? videoProvider.message;
    if (project.settings.visualMode === 'ai-video' && project.settings.lipSync) return '真正影片模式目前不支援可驗證的本機口型同步。';
    if (videoPreflightIssue) return videoPreflightIssue;
    return undefined;
  }, [project, videoPreflightIssue, videoProvider]);

  const agentModelLabel = selectedModelId === 'auto'
    ? catalog.selectedModel ?? '自動選擇'
    : catalog.models.find((model) => model.id === selectedModelId)?.name ?? selectedModelId;

  const navItems: Array<{ id: StudioView; label: string; icon: typeof FileText }> = [
    { id: 'start', label: '劇本', icon: FileText },
    { id: 'production', label: '製作', icon: Clapperboard },
    { id: 'models', label: '模型', icon: Cpu },
    { id: 'settings', label: '設定', icon: Settings },
  ];

  return (
    <div className={`studio-shell${project.settings.reducedMotion ? ' reduce-motion' : ''}`}>
      <header className="app-header">
        <Brand />
        <div className="project-header">
          <strong>{project.title || '未命名專案'}</strong>
          <small>{saveState === 'saving' ? '儲存中' : saveState === 'error' ? '儲存失敗' : '已儲存'}</small>
        </div>
        <div className="app-header__status">
          <StatusPill
            tone={project.settings.visualMode === 'ai-video'
              ? (videoProvider.available ? 'good' : 'danger')
              : (hardware.runtimeReady ? 'good' : 'warning')}
          >
            <Film size={13} />
            {project.settings.visualMode === 'ai-video'
              ? `影片模型 ${videoProvider.available ? '已連線' : '未就緒'}`
              : '動態漫畫模式'}
          </StatusPill>
          <StatusPill tone={catalog.available ? 'good' : 'danger'}><Bot size={13} /> AI 製片團隊 {catalog.available ? '已連線' : '未連線'}</StatusPill>
        </div>
      </header>

      <aside className="app-rail">
        <Brand compact />
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={view === item.id ? 'is-active' : ''} onClick={() => setView(item.id)}>
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="rail-status"><span className={catalog.available ? 'is-on' : ''} /><small>{catalog.available ? '連線' : '離線'}</small></div>
      </aside>

      <main className="app-content">
        {view === 'start' && (
          <StartView
            project={project}
            agentReady={catalog.available}
            agentModelLabel={agentModelLabel}
            videoProvider={videoProvider}
            busy={workState === 'writer'}
            onStoryChange={changeStory}
            onSettingChange={changeSetting}
            onSubmitToWriter={() => void submitToWriter()}
            onOpenModels={() => setView('models')}
            onUseSample={() => changeStory(sampleStory)}
            onContinue={() => setView('production')}
          />
        )}
        {view === 'production' && (
          <ProductionView
            project={project}
            render={render}
            busy={workState !== 'idle'}
            selectedTarget={selectedTarget}
            canRunTeam={canRunTeam}
            canRender={canRender}
            renderBlockedReason={renderBlockedReason}
            onSelectTarget={setSelectedTarget}
            onSendMessage={sendMessage}
            onRunTeam={() => void runTeam()}
            onStartRender={() => void startVideo()}
            onControlRender={(action) => void controlVideo(action)}
            onReviewScene={reviewScene}
            onRevealOutput={() => void revealOutput()}
            onApplyProposal={applyProposal}
            onRejectProposal={rejectProposal}
            referenceRequired={project.settings.visualMode === 'ai-video' && videoProvider.capabilities.inputImageBinding}
            onImportCharacterReference={importCharacterReference}
            onClearCharacterReference={clearCharacterReference}
            onBackToScript={() => setView('start')}
          />
        )}
        {view === 'models' && (
          <ModelsView
            catalog={catalog}
            selectedModelId={selectedModelId}
            modelTest={modelTest}
            runtimeSetup={runtimeSetup}
            hardware={hardware}
            videoProvider={videoProvider}
            refreshing={refreshing}
            testingModel={testingModel}
            configuringVideo={workState === 'video-provider'}
            onRefresh={() => void refreshEnvironment()}
            onSelectModel={setSelectedModelId}
            onTestModel={() => void runModelTest()}
            onRepairRuntime={() => void repairRuntime()}
            onConfigureVideo={configureVideo}
            onClearVideo={clearVideo}
          />
        )}
        {view === 'settings' && (
          <SettingsView
            project={project}
            hardware={hardware}
            update={update}
            videoProvider={videoProvider}
            checkingUpdate={checkingUpdate}
            installingUpdate={installingUpdate}
            onSettingChange={changeSetting}
            onCheckUpdate={() => void checkUpdate()}
            onInstallUpdate={() => void installUpdate()}
            onOpenModels={() => setView('models')}
            onResetProject={resetProject}
          />
        )}
      </main>

      {(notice || fatalError) && (
        <div className={`toast${fatalError ? ' toast--error' : ''}`} role="status">
          <span>{fatalError ? '!' : <Check size={15} />}</span>
          <p>{fatalError || notice}</p>
          <button type="button" onClick={() => { setFatalError(''); setNotice(''); }}>關閉</button>
        </div>
      )}
    </div>
  );
}
