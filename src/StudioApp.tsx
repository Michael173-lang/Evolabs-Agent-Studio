import {
  BrainCircuit,
  Check,
  Clapperboard,
  Cpu,
  FileText,
  Film,
  LoaderCircle,
  MessageSquareText,
  Settings,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyArtifactToWorkspace,
  applyPlanToWorkspace,
  createAgentWorkspace,
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
} from './lib/agentPipeline';
import {
  checkAppUpdate,
  controlRenderJob,
  getAiRuntimeSetup,
  getHardwareProfile,
  getModelInstall,
  getRenderJob,
  installAppUpdate,
  loadProject,
  revealRenderOutput,
  saveProject,
  startAiRuntimeSetup,
  startModelInstall,
  startRenderJob,
} from './lib/bridge';
import { createId } from './lib/id';
import { planningFingerprint } from './lib/planner';
import {
  getAgentModels,
  isDesktopStudio,
  runAgentStageV2,
  type AgentModelCatalog,
} from './lib/studioBridge';
import { createBlankProject, sampleStory } from './state/defaultProject';
import ModelsView from './studio/ModelsView';
import ProductionView from './studio/ProductionView';
import SettingsView from './studio/SettingsView';
import StartView from './studio/StartView';
import { Brand, ProgressBar, StatusPill } from './studio/ui';
import type {
  AgentId,
  AgentMessage,
  AgentStage,
  AgentWorkspace,
  AppUpdateInfo,
  EvolabsProject,
  HardwareProfile,
  ModelInstallSnapshot,
  ProductionBible,
  RenderControlAction,
  RenderJobSnapshot,
  RenderSceneSnapshot,
  RuntimeCapabilities,
  RuntimeSetupSnapshot,
  Scene,
  StoryPlan,
} from './types';

type StudioView = 'start' | 'production' | 'models' | 'settings';
type PipelineActivity = 'idle' | 'writer' | 'team';
type SaveState = 'saved' | 'saving' | 'error';

const selectedModelKey = 'evolabs:selected-agent-model';
const renderSessionKey = 'evolabs:render-session-v2';
const modelInstallSessionKey = 'evolabs:model-install-session-v2';
const openRailAcceptedKey = 'evolabs:openrail-accepted';
const openRailLicenseId = 'creativeml-openrail-m';
const terminalRenderStates = new Set<RenderJobSnapshot['state']>(['completed', 'failed', 'canceled']);

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
  provider: 'fallback',
  models: [],
  message: '正在檢查本機 Agent 模型。',
};

const defaultRuntimeSetup: RuntimeSetupSnapshot = {
  state: 'idle',
  stage: 'system',
  progress: 0,
  title: '準備 Agent Runtime',
  message: '等待開始。',
  updatedAtUnixMs: Date.now(),
  steps: [
    { id: 'system', title: '檢查電腦與核心', state: 'queued', detail: '等待開始' },
    { id: 'llmster', title: '準備 AI Agent 服務', state: 'queued', detail: '等待開始' },
    { id: 'model', title: '下載 Agent 模型', state: 'queued', detail: '等待開始' },
    { id: 'load', title: '載入並最佳化', state: 'queued', detail: '等待開始' },
    { id: 'verify', title: '最終健康檢查', state: 'queued', detail: '等待開始' },
  ],
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '本機服務沒有回應。';
}

function runtimeCapabilities(hardware: HardwareProfile): RuntimeCapabilities {
  return hardware.capabilities ?? { ...noCapabilities, comicCore: hardware.runtimeReady };
}

function aiImagesReady(project: EvolabsProject, hardware: HardwareProfile): boolean {
  const capabilities = runtimeCapabilities(hardware);
  return project.settings.mode === 'anime' ? capabilities.animeImage : capabilities.realisticImage;
}

function renderReadiness(project: EvolabsProject, hardware: HardwareProfile): { ready: boolean; reason?: string } {
  if (!hardware.runtimeReady) return { ready: false, reason: '本機影片引擎尚未就緒。' };
  const capabilities = runtimeCapabilities(hardware);
  if (project.settings.lipSync && project.settings.visualMode !== 'ai-images') {
    return { ready: false, reason: '單人對嘴需要 AI 畫面模式。' };
  }
  if (project.settings.lipSync && !capabilities.lipSync) {
    return { ready: false, reason: 'MuseTalk 健康檢查尚未通過。' };
  }
  if (project.settings.visualMode === 'cards') {
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

function mergeRenderSceneState(scenes: Scene[], snapshots: RenderSceneSnapshot[]): Scene[] {
  const index = new Map(snapshots.map((snapshot) => [snapshot.sceneId, snapshot]));
  let changed = false;
  const merged = scenes.map((scene) => {
    const latest = index.get(scene.id);
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

function withMessage(workspace: AgentWorkspace, message: AgentMessage): AgentWorkspace {
  return { ...workspace, messages: [...workspace.messages, message] };
}

function userMessage(text: string): AgentMessage {
  return {
    id: createId('message'),
    sender: '你',
    text,
    kind: 'user',
    createdAt: new Date().toISOString(),
  };
}

function systemMessage(text: string, agentId?: AgentId): AgentMessage {
  return {
    id: createId('message'),
    sender: agentId === 'screenwriter' ? '編劇師' : agentId === 'director' ? 'Evo 導演' : 'Evolabs',
    text,
    kind: agentId ? 'agent' : 'system',
    agentId,
    createdAt: new Date().toISOString(),
  };
}

function isModelSelectionError(message: string): boolean {
  return /模型.*(?:沒有載入|尚未載入|識別碼格式無效)/u.test(message);
}

function selectedModelIsListed(catalog: AgentModelCatalog, selectedModelId: string): boolean {
  return selectedModelId === 'auto' || catalog.models.some((model) => model.id === selectedModelId);
}

function activeViewForProject(project: EvolabsProject): StudioView {
  if (project.productionBible?.script || project.characters.length || project.scenes.length) return 'production';
  return 'start';
}

export default function StudioApp() {
  const [view, setView] = useState<StudioView>('start');
  const [project, setProject] = useState<EvolabsProject>(() => createBlankProject());
  const [hardware, setHardware] = useState<HardwareProfile>(defaultHardware);
  const [catalog, setCatalog] = useState<AgentModelCatalog>(defaultCatalog);
  const [selectedModelId, setSelectedModelIdState] = useState(() => localStorage.getItem(selectedModelKey) || 'auto');
  const [runtimeSetup, setRuntimeSetup] = useState<RuntimeSetupSnapshot>(defaultRuntimeSetup);
  const [render, setRender] = useState<RenderJobSnapshot | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [install, setInstall] = useState<ModelInstallSnapshot | null>(null);
  const [activeInstallId, setActiveInstallId] = useState<string | null>(null);
  const [licenseAccepted, setLicenseAcceptedState] = useState(() => localStorage.getItem(openRailAcceptedKey) === 'true');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [activity, setActivity] = useState<PipelineActivity>('idle');
  const [pipelineError, setPipelineError] = useState('');
  const [notice, setNotice] = useState('');
  const [writerReady, setWriterReady] = useState(false);
  const projectRef = useRef(project);
  const runTokenRef = useRef(0);
  const desktop = isDesktopStudio();

  const workspace = useMemo(
    () => project.agentWorkspace ?? createAgentWorkspace(project),
    [project],
  );

  const commitProject = useCallback((next: EvolabsProject) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const mutateProject = useCallback((recipe: (current: EvolabsProject) => EvolabsProject) => {
    const next = recipe(projectRef.current);
    commitProject({ ...next, updatedAt: new Date().toISOString() });
  }, [commitProject]);

  const mutateWorkspace = useCallback((recipe: (workspace: AgentWorkspace) => AgentWorkspace) => {
    mutateProject((current) => ({
      ...current,
      agentWorkspace: recipe(current.agentWorkspace ?? createAgentWorkspace(current)),
    }));
  }, [mutateProject]);

  const refreshEnvironment = useCallback(async () => {
    const [hardwareResult, catalogResult, setupResult] = await Promise.allSettled([
      getHardwareProfile(),
      getAgentModels(),
      getAiRuntimeSetup(),
    ]);
    if (hardwareResult.status === 'fulfilled') setHardware(hardwareResult.value);
    if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
    if (setupResult.status === 'fulfilled') setRuntimeSetup(setupResult.value);
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.allSettled([
      loadProject(),
      getHardwareProfile(),
      getAgentModels(),
      getAiRuntimeSetup(),
    ]).then((results) => {
      if (disposed) return;
      const loaded = results[0].status === 'fulfilled' ? results[0].value : null;
      if (loaded) {
        const hydratedProject = {
          ...loaded,
          agentWorkspace: refreshScriptNode(loaded.agentWorkspace ?? createAgentWorkspace(loaded), loaded),
        };
        commitProject(hydratedProject);
        setWriterReady(Boolean(hydratedProject.productionBible?.script));
        setView(activeViewForProject(hydratedProject));
      }
      if (results[1].status === 'fulfilled') setHardware(results[1].value);
      if (results[2].status === 'fulfilled') setCatalog(results[2].value);
      if (results[3].status === 'fulfilled') setRuntimeSetup(results[3].value);
      try {
        const renderSession = JSON.parse(localStorage.getItem(renderSessionKey) || 'null') as { jobId?: unknown; projectId?: unknown } | null;
        if (renderSession && typeof renderSession.jobId === 'string' && (!loaded || renderSession.projectId === loaded.id)) {
          setActiveJobId(renderSession.jobId);
        }
      } catch {
        localStorage.removeItem(renderSessionKey);
      }
      try {
        const installSession = JSON.parse(localStorage.getItem(modelInstallSessionKey) || 'null') as { installId?: unknown } | null;
        if (typeof installSession?.installId === 'string') setActiveInstallId(installSession.installId);
      } catch {
        localStorage.removeItem(modelInstallSessionKey);
      }
      setHydrated(true);
    });
    return () => { disposed = true; };
  }, [commitProject]);

  useEffect(() => {
    if (!hydrated) return;
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      void saveProject(project)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [hydrated, project]);

  useEffect(() => {
    if (!activeInstallId) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await getModelInstall(activeInstallId);
        if (disposed) return;
        setInstall(snapshot);
        if (snapshot.state === 'completed') {
          localStorage.removeItem(modelInstallSessionKey);
          setActiveInstallId(null);
          await refreshEnvironment();
          setNotice(`${snapshot.packName || '視覺模型'}已安裝並通過驗證。`);
          return;
        }
        if (snapshot.state === 'failed' || snapshot.state === 'canceled') {
          localStorage.removeItem(modelInstallSessionKey);
          setActiveInstallId(null);
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
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeInstallId, refreshEnvironment]);

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
          return {
            ...withScenes,
            agentWorkspace: syncWorkspaceWithRender(
              withScenes.agentWorkspace ?? createAgentWorkspace(withScenes),
              withScenes,
              snapshot,
            ),
          };
        });
        if (terminalRenderStates.has(snapshot.state)) {
          setActiveJobId(null);
          localStorage.removeItem(renderSessionKey);
          if (snapshot.state === 'failed') setPipelineError(snapshot.error?.message || snapshot.message || '生成失敗。');
          if (snapshot.state === 'completed') setNotice('成片已完成，可直接開啟輸出資料夾。');
          return;
        }
        timer = window.setTimeout(() => void poll(), 700);
      } catch (error) {
        if (disposed) return;
        setPipelineError(errorMessage(error));
        timer = window.setTimeout(() => void poll(), 1500);
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
    setNotice(normalized === 'auto' ? '已改為自動選擇 Agent 模型。' : `已選擇模型：${normalized}`);
  }, []);

  const setLicenseAccepted = useCallback((accepted: boolean) => {
    setLicenseAcceptedState(accepted);
    localStorage.setItem(openRailAcceptedKey, accepted ? 'true' : 'false');
  }, []);

  const changeSetting = useCallback(<K extends keyof EvolabsProject['settings']>(
    key: K,
    value: EvolabsProject['settings'][K],
  ) => {
    mutateProject((current) => ({
      ...current,
      settings: { ...current.settings, [key]: value },
      plannedStoryFingerprint: undefined,
    }));
  }, [mutateProject]);

  const changeStory = useCallback((story: string) => {
    const current = projectRef.current;
    if (story === current.story) return;
    const nextBase: EvolabsProject = {
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
      updatedAt: new Date().toISOString(),
    };
    nextBase.agentWorkspace = refreshScriptNode(createAgentWorkspace(nextBase), nextBase);
    commitProject(nextBase);
    setWriterReady(false);
    setPipelineError('');
    setRender(null);
    setActiveJobId(null);
    localStorage.removeItem(renderSessionKey);
  }, [commitProject]);

  const resetProject = useCallback(() => {
    runTokenRef.current += 1;
    const blank = createBlankProject();
    commitProject(blank);
    setWriterReady(false);
    setActivity('idle');
    setRender(null);
    setPipelineError('');
    setNotice('已建立新的空白專案。');
    setView('start');
  }, [commitProject]);

  const resolveModelLabel = useCallback(() => {
    if (selectedModelId !== 'auto') return selectedModelId;
    return catalog.selectedModel || 'Evolabs 內建專家';
  }, [catalog.selectedModel, selectedModelId]);

  const submitToWriter = useCallback(async () => {
    const source = projectRef.current;
    const story = source.story.trim();
    if (story.length < 4) {
      setPipelineError('請至少輸入 4 個字，再送交編劇。');
      return;
    }
    if (story.length > 100_000) {
      setPipelineError('劇本超過 100,000 字上限。請分成多個專案。');
      return;
    }
    if (!selectedModelIsListed(catalog, selectedModelId)) {
      setPipelineError(`模型「${selectedModelId}」目前沒有載入。請到模型頁重新整理或改選已載入模型。`);
      setView('models');
      return;
    }

    const token = ++runTokenRef.current;
    setActivity('writer');
    setPipelineError('');
    setNotice('');
    setWriterReady(false);
    setView('production');

    let workspace = createAgentWorkspace(source);
    workspace = {
      ...refreshScriptNode(workspace, source),
      runId: createId('agent_run'),
      state: 'planning',
      activeAgentId: 'screenwriter',
      startedAt: new Date().toISOString(),
      provider: catalog.available ? 'lm-studio' : 'fallback',
      providerModel: catalog.available ? resolveModelLabel() : undefined,
    };
    workspace = withMessage(workspace, userMessage(story));
    workspace = setAgentPhase(
      workspace,
      'screenwriter',
      'working',
      15,
      '閱讀完整劇本並建立故事結構',
      `我已收到你的劇本（${story.length.toLocaleString()} 字）。先確認角色、因果、衝突與節奏，再交付可供後續團隊共用的結構。`,
    );
    let working: EvolabsProject = {
      ...source,
      title: '編劇分析中',
      characters: [],
      scenes: [],
      productionBible: {},
      agentWorkspace: workspace,
      plannedStoryFingerprint: undefined,
      workflowStep: 0,
      maxUnlockedStep: 0,
      updatedAt: new Date().toISOString(),
    };
    commitProject(working);
    await saveProject(working).catch(() => undefined);

    const fallback = createFallbackProduction(working);
    let usedFallback = false;
    let fallbackReason = '';
    let raw: unknown = fallback.bible.script;
    if (catalog.available) {
      try {
        raw = await runAgentStageV2(
          'screenwriter',
          working,
          { settings: working.settings },
          selectedModelId,
        );
      } catch (error) {
        fallbackReason = errorMessage(error);
        if (selectedModelId !== 'auto' && isModelSelectionError(fallbackReason)) {
          workspace = setAgentPhase(workspace, 'screenwriter', 'failed', 15, '選擇的模型目前不可用', fallbackReason);
          working = { ...working, agentWorkspace: workspace, updatedAt: new Date().toISOString() };
          commitProject(working);
          await saveProject(working).catch(() => undefined);
          setPipelineError(fallbackReason);
          setActivity('idle');
          setView('models');
          return;
        }
        usedFallback = true;
      }
    } else {
      usedFallback = true;
      fallbackReason = catalog.message;
    }
    if (runTokenRef.current !== token) return;

    const script = normalizeScriptAnalysis(raw, working);
    const bible: ProductionBible = { script };
    workspace = applyArtifactToWorkspace(
      workspace,
      { ...working, title: script.title, productionBible: bible },
      'screenwriter',
      bible,
      `編劇交付完成：${script.beats.length} 個故事節點、${script.characterSeeds.length} 個角色種子、${script.locationSeeds.length} 個場景需求。`,
    );
    workspace = {
      ...workspace,
      state: 'planning',
      activeAgentId: undefined,
      provider: usedFallback ? 'fallback' : 'lm-studio',
      providerModel: usedFallback ? undefined : resolveModelLabel(),
    };
    if (usedFallback) {
      workspace = withMessage(
        workspace,
        systemMessage(`本機模型這次沒有完成可解析交付：${fallbackReason}。編劇階段已改由 Evolabs 內建專家完成；結果已清楚標示，不會假裝是所選模型產生。`),
      );
    }
    working = {
      ...working,
      title: script.title,
      productionBible: bible,
      agentWorkspace: workspace,
      updatedAt: new Date().toISOString(),
    };
    commitProject(working);
    await saveProject(working).catch(() => undefined);
    setWriterReady(true);
    setActivity('idle');
    setNotice(usedFallback ? '編劇已交付；本次使用內建專家備援。' : `編劇已使用 ${resolveModelLabel()} 完成交付。`);
  }, [catalog.available, catalog.message, commitProject, resolveModelLabel, selectedModelId]);

  const runFullProduction = useCallback(async () => {
    const source = projectRef.current;
    const script = source.productionBible?.script;
    if (!script) {
      setPipelineError('請先完成編劇交付。');
      return;
    }
    if (!selectedModelIsListed(catalog, selectedModelId)) {
      setPipelineError(`模型「${selectedModelId}」目前沒有載入。請到模型頁重新整理或改選已載入模型。`);
      setView('models');
      return;
    }
    const token = ++runTokenRef.current;
    setActivity('team');
    setPipelineError('');
    setNotice('');
    setView('production');

    const fallback = createFallbackProduction(source);
    let bible: ProductionBible = { ...source.productionBible, script };
    let characters = source.characters;
    let scenes = source.scenes;
    let working: EvolabsProject = { ...source, productionBible: bible };
    let workspace: AgentWorkspace = {
      ...(source.agentWorkspace ?? createAgentWorkspace(source)),
      state: 'planning',
      activeAgentId: 'art-director',
      startedAt: source.agentWorkspace?.startedAt || new Date().toISOString(),
      failure: undefined,
    };
    let localStages = 0;
    let fallbackStages = 0;

    const ensureCurrent = () => {
      if (runTokenRef.current !== token) throw new Error('PIPELINE_REPLACED');
    };
    const publish = async () => {
      working = { ...working, productionBible: bible, characters, scenes, agentWorkspace: workspace, updatedAt: new Date().toISOString() };
      commitProject(working);
      await saveProject(working).catch(() => undefined);
      ensureCurrent();
    };
    const beginStage = async (stage: AgentStage, agentId: AgentId, progress: number, task: string, message: string) => {
      workspace = setAgentPhase(workspace, agentId, 'working', progress, task, message);
      await publish();
      return stage;
    };
    const resolveStage = async <T,>(
      stage: AgentStage,
      context: unknown,
      fallbackValue: T,
      normalize: (value: unknown) => T,
    ): Promise<T> => {
      if (!catalog.available) {
        fallbackStages += 1;
        return fallbackValue;
      }
      try {
        const raw = await runAgentStageV2(stage, working, context, selectedModelId);
        localStages += 1;
        return normalize(raw);
      } catch (error) {
        const stageError = errorMessage(error);
        if (selectedModelId !== 'auto' && isModelSelectionError(stageError)) {
          throw new Error(stageError);
        }
        fallbackStages += 1;
        const agentId = stage === 'director-review' ? 'director' : stage;
        workspace = setAgentPhase(
          workspace,
          agentId,
          'working',
          Math.max(45, workspace.agents.find((agent) => agent.id === agentId)?.progress ?? 45),
          '模型交付無法解析，切換到內建專家',
          `${stageError}。此階段已由內建專家接手，其餘已完成內容不會重做。`,
        );
        await publish();
        return fallbackValue;
      }
    };
    const completeStage = async (stage: AgentStage, projectSnapshot: EvolabsProject, message: string) => {
      workspace = applyArtifactToWorkspace(workspace, projectSnapshot, stage, bible, message);
      working = projectSnapshot;
      await publish();
    };

    try {
      await beginStage('art-director', 'art-director', 24, '建立全片視覺聖經', '我正在把色彩、材質、光線與攝影語言固定成全片共用規則。');
      const artDirection = await resolveStage(
        'art-director',
        { script },
        fallback.bible.artDirection,
        (value) => normalizeArtDirection(value, working),
      );
      bible = { ...bible, artDirection };
      await completeStage('art-director', { ...working, productionBible: bible }, `視覺聖經完成：${artDirection.styleName}。`);

      await beginStage('ip-designer', 'ip-designer', 34, '建立世界觀與連戲規則', '我正在鎖定角色、服裝、場景、道具、時間與光源不能漂移的規則。');
      const ipBible = await resolveStage(
        'ip-designer',
        { script, artDirection },
        fallback.bible.ipBible,
        (value) => normalizeIpBible(value, working, script),
      );
      bible = { ...bible, ipBible };
      await completeStage('ip-designer', { ...working, productionBible: bible }, `IP／連戲聖經完成：${ipBible.continuityRules.length} 條連戲規則。`);

      await beginStage('character-designer', 'character-designer', 46, '建立角色身份資產', '角色設計師正在固定臉型、髮型、服裝、配件、聲線與表情規則。');
      characters = await resolveStage(
        'character-designer',
        { script, artDirection, ipBible },
        fallback.characters,
        (value) => normalizeCharacters(value, working, script),
      );
      await completeStage('character-designer', { ...working, characters, workflowStep: 1, maxUnlockedStep: 1 }, `已建立 ${characters.length} 個角色資產。`);

      await beginStage('scene-designer', 'scene-designer', 58, '建立可重用場景資產', '場景設計師正在固定地點格局、材質、時間、天氣、光線與道具位置。');
      const locations = await resolveStage(
        'scene-designer',
        { script, artDirection, ipBible, characters },
        fallback.bible.locations,
        (value) => normalizeLocations(value, working, script, artDirection),
      );
      bible = { ...bible, locations };
      await completeStage('scene-designer', { ...working, characters, productionBible: bible, workflowStep: 2, maxUnlockedStep: 2 }, `已建立 ${locations.length} 個場景資產。`);

      await beginStage('storyboard-artist', 'storyboard-artist', 70, '建立可生成分鏡', '分鏡師正在把故事、角色與場景轉成有首尾幀、運鏡與連戲關係的鏡頭。');
      scenes = await resolveStage(
        'storyboard-artist',
        { script, artDirection, ipBible, characters, locations },
        fallback.scenes,
        (value) => normalizeStoryboard(value, working, script, artDirection, characters, locations),
      );
      await completeStage('storyboard-artist', { ...working, characters, scenes, workflowStep: 3, maxUnlockedStep: 3 }, `分鏡完成：${scenes.length} 個鏡頭。`);

      await beginStage('sound-director', 'sound-director', 81, '安排配音、環境音與音樂', '聲音導演正在依鏡頭配置對白節奏、環境音、音效與音樂走向。');
      const sound = await resolveStage(
        'sound-director',
        { script, artDirection, ipBible, characters, locations, scenes },
        fallback.bible.sound,
        (value) => normalizeSound(value, scenes, characters),
      );
      const cueByScene = new Map(sound.cues.map((cue) => [cue.sceneId, cue]));
      scenes = scenes.map((scene) => {
        const cue = cueByScene.get(scene.id);
        return cue ? { ...scene, musicCue: cue.musicCue, ambience: cue.ambience, soundEffects: cue.soundEffects } : scene;
      });
      bible = { ...bible, sound };
      await completeStage('sound-director', { ...working, characters, scenes, productionBible: bible }, `聲音設計完成：${sound.cues.length} 個鏡頭 Cue。`);

      await beginStage('director-review', 'director', 92, '總導演驗收', '我正在檢查可生成性、角色一致性、場景連續、節奏與聲音。');
      const directorReview = await resolveStage(
        'director-review',
        { productionBible: bible, characters, scenes },
        fallback.bible.directorReview,
        (value) => normalizeDirectorReview(value, scenes),
      );
      bible = { ...bible, directorReview };
      await completeStage('director-review', { ...working, characters, scenes, productionBible: bible }, `總導演驗收：${directorReview.score}/100。${directorReview.approved ? '可進入生成。' : '已保留具體修正事項。'}`);

      const plan: StoryPlan = productionPlan(
        working,
        bible,
        characters,
        scenes,
        localStages ? 'multi-agent' : 'fast-planner',
      );
      const provider = localStages && fallbackStages ? 'hybrid' : localStages ? 'lm-studio' : 'fallback';
      workspace = applyPlanToWorkspace(workspace, working, plan, provider, localStages ? resolveModelLabel() : undefined);
      workspace = {
        ...workspace,
        state: 'preparing-models',
        provider,
        providerModel: localStages ? resolveModelLabel() : undefined,
      };
      workspace = withMessage(
        workspace,
        systemMessage(
          localStages
            ? `製作藍圖完成：${localStages} 個階段由 ${resolveModelLabel()} 交付${fallbackStages ? `，${fallbackStages} 個階段由內建專家接手` : ''}。你可以檢查角色、場景與分鏡，再開始生成成片。`
            : '製作藍圖已由內建專家完成。你可以先檢查角色、場景與分鏡，再開始生成成片。',
          'director',
        ),
      );
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
      setActivity('idle');
      setNotice('製作藍圖完成。請檢查內容後按「生成成片」。');
    } catch (error) {
      if (errorMessage(error) === 'PIPELINE_REPLACED') return;
      const message = errorMessage(error);
      setPipelineError(message);
      setActivity('idle');
      mutateWorkspace((current) => ({ ...current, state: 'failed', failure: message }));
    }
  }, [catalog.available, commitProject, mutateWorkspace, resolveModelLabel, selectedModelId]);

  const startRender = useCallback(async () => {
    const current = projectRef.current;
    if (!current.scenes.length) {
      setPipelineError('尚未建立分鏡，不能開始生成成片。');
      return;
    }
    const readiness = renderReadiness(current, hardware);
    if (!readiness.ready) {
      setPipelineError(readiness.reason || '生成環境尚未就緒。');
      setView('models');
      return;
    }
    try {
      setPipelineError('');
      const result = await startRenderJob(current, false);
      setActiveJobId(result.jobId);
      setRender({
        jobId: result.jobId,
        projectId: current.id,
        scope: 'full',
        state: 'queued',
        stage: 'idle',
        overallProgress: 0,
        sceneProgress: 0,
        elapsedSeconds: 0,
        scenes: current.scenes.map((scene) => ({ sceneId: scene.id, state: 'queued', progress: 0 })),
        message: '生成工作已建立',
      });
      localStorage.setItem(renderSessionKey, JSON.stringify({ jobId: result.jobId, projectId: current.id }));
      mutateWorkspace((currentWorkspace) => ({ ...currentWorkspace, state: 'rendering', activeAgentId: 'director', failure: undefined }));
      setView('production');
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, [hardware, mutateWorkspace]);

  const handleRenderControl = useCallback(async (action: RenderControlAction) => {
    const jobId = activeJobId || render?.jobId;
    if (!jobId) return;
    try {
      await controlRenderJob(jobId, action);
      setNotice(action === 'cancel' ? '已送出取消要求。' : action === 'pause' ? '已送出暫停要求。' : '已送出繼續要求。');
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, [activeJobId, render?.jobId]);

  const revealOutput = useCallback(async () => {
    const jobId = render?.jobId;
    if (!jobId) return;
    try {
      await revealRenderOutput(jobId);
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, [render?.jobId]);

  const installVisualModel = useCallback(async (packId: string) => {
    if (!licenseAccepted) {
      setPipelineError('請先確認視覺模型授權。');
      return;
    }
    try {
      setPipelineError('');
      const result = await startModelInstall(packId, [openRailLicenseId]);
      setActiveInstallId(result.installId);
      const queued: ModelInstallSnapshot = {
        installId: result.installId,
        packId,
        state: 'queued',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        message: '正在驗證下載來源與磁碟空間。',
      };
      setInstall(queued);
      localStorage.setItem(modelInstallSessionKey, JSON.stringify({ installId: result.installId, packId }));
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, [licenseAccepted]);

  const repairRuntime = useCallback(async () => {
    try {
      setPipelineError('');
      const snapshot = await startAiRuntimeSetup(true);
      setRuntimeSetup(snapshot);
      setNotice('Agent Runtime 修復已開始；可留在模型頁查看進度。');
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, []);

  const checkUpdate = useCallback(async () => {
    try {
      const info = await checkAppUpdate();
      setUpdateInfo(info);
      setNotice(info.message);
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, []);

  const installUpdate = useCallback(async () => {
    try {
      await installAppUpdate();
    } catch (error) {
      setPipelineError(errorMessage(error));
    }
  }, []);

  const navItems: Array<{ view: StudioView; label: string; icon: typeof FileText }> = [
    { view: 'start', label: '劇本', icon: FileText },
    { view: 'production', label: '製作', icon: Clapperboard },
    { view: 'models', label: '模型', icon: BrainCircuit },
    { view: 'settings', label: '設定', icon: Settings },
  ];
  const runtimeWorking = runtimeSetup.state === 'running';
  const renderRunning = Boolean(render && !terminalRenderStates.has(render.state));
  const hasProject = Boolean(project.story.trim() || project.productionBible?.script || project.scenes.length);

  return (
    <div className="studio-app">
      <aside className="studio-rail">
        <Brand compact />
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            const disabled = item.view === 'production' && !hasProject;
            return (
              <button
                key={item.view}
                type="button"
                className={view === item.view ? 'active' : ''}
                disabled={disabled}
                onClick={() => setView(item.view)}
                aria-label={item.label}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="rail-status">
          <span className={catalog.available ? 'online' : 'offline'} />
          <small>{catalog.available ? 'AI' : 'OFF'}</small>
        </div>
      </aside>

      <section className="studio-shell">
        <header className="studio-topbar">
          <Brand />
          <div className="topbar-project">
            <strong>{project.title || '未命名專案'}</strong>
            <span>{saveState === 'saving' ? '正在儲存' : saveState === 'error' ? '儲存失敗' : '已儲存'}</span>
          </div>
          <div className="topbar-health">
            {activity !== 'idle' && <StatusPill tone="working">{activity === 'writer' ? '編劇處理中' : '團隊製作中'}</StatusPill>}
            {renderRunning && <StatusPill tone="working">影片生成 {Math.round(render?.overallProgress || 0)}%</StatusPill>}
            <span className={`health-chip ${hardware.runtimeReady ? 'good' : 'warning'}`}><Cpu size={14} /> Engine {hardware.runtimeReady ? '就緒' : '未就緒'}</span>
            <span className={`health-chip ${catalog.available ? 'good' : 'warning'}`}><BrainCircuit size={14} /> Agent {catalog.available ? '已連線' : '備援'}</span>
          </div>
        </header>

        <div className="studio-content">
          {!hydrated ? (
            <div className="studio-loading"><LoaderCircle size={28} className="spin" /><strong>正在讀取工作室狀態</strong><p>專案、Engine、模型與未完成工作會一起恢復。</p></div>
          ) : view === 'start' ? (
            <StartView
              project={project}
              hardware={hardware}
              catalog={catalog}
              selectedModelId={selectedModelId}
              submitting={activity === 'writer'}
              error={pipelineError}
              onStoryChange={changeStory}
              onSettingChange={changeSetting}
              onModelChange={setSelectedModelId}
              onSubmit={() => void submitToWriter()}
              onExample={() => changeStory(sampleStory)}
              onReset={resetProject}
              onOpenModels={() => setView('models')}
            />
          ) : view === 'production' ? (
            <ProductionView
              project={project}
              workspace={workspace}
              catalog={catalog}
              selectedModelId={selectedModelId}
              writerReady={writerReady}
              runningWriter={activity === 'writer'}
              runningTeam={activity === 'team'}
              render={render}
              pipelineError={pipelineError}
              onContinueTeam={() => void runFullProduction()}
              onStartRender={() => void startRender()}
              onControlRender={(action) => void handleRenderControl(action)}
              onReveal={() => void revealOutput()}
              onBackToScript={() => setView('start')}
              onRetryWriter={() => void submitToWriter()}
            />
          ) : view === 'models' ? (
            <ModelsView
              hardware={hardware}
              catalog={catalog}
              selectedModelId={selectedModelId}
              licenseAccepted={licenseAccepted}
              install={install}
              repairing={runtimeWorking}
              runtimeProgress={runtimeSetup.progress}
              onSelectModel={setSelectedModelId}
              onAcceptLicense={setLicenseAccepted}
              onInstallVisual={(packId) => void installVisualModel(packId)}
              onRepairRuntime={() => void repairRuntime()}
              onRefresh={() => void refreshEnvironment()}
            />
          ) : (
            <SettingsView
              project={project}
              hardware={hardware}
              saveState={saveState}
              updateInfo={updateInfo}
              onSettingChange={changeSetting}
              onCheckUpdate={() => void checkUpdate()}
              onInstallUpdate={() => void installUpdate()}
            />
          )}
        </div>

        {(notice || (pipelineError && view !== 'start' && view !== 'production')) && (
          <div className={`studio-notice ${pipelineError ? 'error' : ''}`}>
            <span>{pipelineError ? <Square size={11} /> : <Check size={13} />}</span>
            <p>{pipelineError || notice}</p>
            <button type="button" onClick={() => { setNotice(''); setPipelineError(''); }}>關閉</button>
          </div>
        )}

        {runtimeWorking && view !== 'models' && (
          <div className="runtime-dock">
            <span><LoaderCircle size={15} className="spin" /><p><strong>{runtimeSetup.title}</strong><small>{runtimeSetup.message}</small></p></span>
            <div><strong>{Math.round(runtimeSetup.progress)}%</strong><ProgressBar value={runtimeSetup.progress} /></div>
            <button type="button" onClick={() => setView('models')}>查看</button>
          </div>
        )}
      </section>

      {!desktop && <div className="browser-mode-badge"><MessageSquareText size={13} /> 瀏覽器預覽：不會安裝模型或輸出實體 MP4</div>}
    </div>
  );
}
