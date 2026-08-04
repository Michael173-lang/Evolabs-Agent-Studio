import { invoke } from '@tauri-apps/api/core';
import type {
  AppUpdateInfo,
  AgentRuntimeProfile,
  AgentStage,
  EvolabsProject,
  HardwareProfile,
  ModelInstallSnapshot,
  ModelPackStatus,
  RenderCharacterAssetSnapshot,
  RenderControlAction,
  RenderJobSnapshot,
  RenderSceneSnapshot,
  RenderStage,
  RuntimeCapabilities,
  RuntimeSetupSnapshot,
  VoiceProfile,
} from '../types';
import { normalizeProject } from '../state/projectMigration';

const storageKey = 'evolabs:last-project';
let projectSaveQueue: Promise<void> = Promise.resolve();
const localImageCache = new Map<string, Promise<string>>();
const maxLocalImageCacheEntries = 64;

export interface ImportedReferenceAsset {
  path?: string;
  dataUrl?: string;
  name: string;
  bytes: number;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const browserProfile: HardwareProfile = {
  gpu: 'NVIDIA GeForce RTX 3050 Laptop GPU',
  vramMb: 4096,
  ramGb: 12,
  cpu: 'Intel Core i5',
  profile: 'rtx3050-4gb',
  runtimeReady: true,
  runtimeVersion: '0.6.0-demo',
  aiReady: false,
  aiProvider: '瀏覽器 Demo',
  capabilities: {
    comicCore: true,
    animeImage: false,
    realisticImage: false,
    characterConsistency: false,
    animeReference: false,
    realisticReference: false,
    multiCharacterReference: false,
    zhVoice: false,
    lipSync: false,
    imageToVideo: false,
  },
  modelPacks: [
    { id: 'functional-core', name: '快速分鏡核心', status: 'ready', version: '0.6.0-demo' },
    { id: 'anime-core', name: '動漫 AI 畫面', status: 'missing', message: '瀏覽器 Demo 不會載入本機模型。' },
    { id: 'realistic-core', name: '寫實 AI 畫面', status: 'missing', message: '瀏覽器 Demo 不會載入本機模型。' },
  ],
};

interface DemoJob {
  snapshot: RenderJobSnapshot;
  lastAdvancedAt: number;
}

const demoJobs = new Map<string, DemoJob>();
const demoStages: Exclude<RenderStage, 'idle' | 'complete'>[] = ['visual', 'motion', 'voice', 'compose'];
const demoTickMs = 700;
const demoProgressPerTick = 6;

const renderJobStates = new Set<RenderJobSnapshot['state']>(['queued', 'running', 'pausing', 'paused', 'canceling', 'canceled', 'failed', 'completed']);
const renderStages = new Set<RenderStage>(['idle', 'visual', 'motion', 'voice', 'compose', 'complete']);
const hardwareProfiles = new Set<HardwareProfile['profile']>(['rtx3050-4gb', 'low-vram', 'balanced', 'high-vram']);
const modelPackStates = new Set<ModelPackStatus['status']>(['ready', 'missing', 'invalid', 'unavailable']);
const modelInstallStates = new Set<ModelInstallSnapshot['state']>(['queued', 'running', 'completed', 'failed', 'canceled']);
const voiceProfiles = new Set<VoiceProfile>(['青年・自然', '少女・清冷', '中性・自然', '成熟・沉穩']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function progressNumber(value: unknown, fallback = 0): number {
  return Math.max(0, Math.min(100, finiteNumber(value, fallback)));
}

export function normalizeHardwareProfile(value: unknown): HardwareProfile {
  if (!isRecord(value)) throw new Error('本機引擎回傳了無效的硬體狀態。');
  const runtimeReady = value.runtimeReady === true;
  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : null;
  const capabilities: RuntimeCapabilities = {
    comicCore: rawCapabilities ? rawCapabilities.comicCore === true : runtimeReady,
    animeImage: rawCapabilities?.animeImage === true,
    realisticImage: rawCapabilities?.realisticImage === true,
    characterConsistency: rawCapabilities?.characterConsistency === true,
    animeReference: rawCapabilities?.animeReference === true || rawCapabilities?.characterConsistency === true,
    realisticReference: rawCapabilities?.realisticReference === true,
    multiCharacterReference: rawCapabilities?.multiCharacterReference === true,
    zhVoice: rawCapabilities?.zhVoice === true,
    lipSync: rawCapabilities?.lipSync === true,
    imageToVideo: rawCapabilities?.imageToVideo === true,
  };
  const modelPacks = Array.isArray(value.modelPacks)
    ? value.modelPacks.flatMap((entry): ModelPackStatus[] => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') return [];
        const status = typeof entry.status === 'string' && modelPackStates.has(entry.status as ModelPackStatus['status'])
          ? entry.status as ModelPackStatus['status']
          : 'invalid';
        return [{
          id: entry.id,
          name: entry.name,
          status,
          version: typeof entry.version === 'string' ? entry.version : undefined,
          message: typeof entry.message === 'string' ? entry.message : undefined,
        }];
      })
    : undefined;
  const profile = typeof value.profile === 'string' && hardwareProfiles.has(value.profile as HardwareProfile['profile'])
    ? value.profile as HardwareProfile['profile']
    : 'low-vram';

  return {
    gpu: typeof value.gpu === 'string' && value.gpu ? value.gpu : '未偵測到顯示卡',
    vramMb: Math.max(0, Math.round(finiteNumber(value.vramMb, 0))),
    ramGb: Math.max(0, Math.round(finiteNumber(value.ramGb, 0))),
    cpu: typeof value.cpu === 'string' && value.cpu ? value.cpu : '未知處理器',
    profile,
    runtimeReady,
    runtimeVersion: typeof value.runtimeVersion === 'string' ? value.runtimeVersion : undefined,
    aiReady: value.aiReady === true,
    aiProvider: typeof value.aiProvider === 'string' && value.aiProvider ? value.aiProvider : undefined,
    capabilities,
    modelPacks,
  };
}

export function normalizeRenderJobSnapshot(value: unknown): RenderJobSnapshot {
  if (!isRecord(value)) throw new Error('本機引擎回傳了無效的工作狀態。');
  const jobId = typeof value.jobId === 'string' ? value.jobId : '';
  const projectId = typeof value.projectId === 'string' ? value.projectId : '';
  if (!jobId || !projectId) throw new Error('本機引擎的工作狀態缺少識別碼。');

  const rawState = typeof value.state === 'string' ? value.state.toLowerCase() : 'failed';
  const stateAliases: Record<string, RenderJobSnapshot['state']> = {
    complete: 'completed',
    succeeded: 'completed',
    cancelled: 'canceled',
  };
  const aliasedState = stateAliases[rawState] ?? rawState;
  const state = renderJobStates.has(aliasedState as RenderJobSnapshot['state'])
    ? aliasedState as RenderJobSnapshot['state']
    : 'failed';
  const rawStage = typeof value.stage === 'string' ? value.stage.toLowerCase() : 'idle';
  const stageAliases: Record<string, RenderStage> = {
    queued: 'idle',
    preparing: 'idle',
    background: 'visual',
    image: 'visual',
    tts: 'voice',
    finalizing: 'compose',
    completed: 'complete',
  };
  const stage = renderStages.has(rawStage as RenderStage)
    ? rawStage as RenderStage
    : stageAliases[rawStage] ?? (state === 'completed' ? 'complete' : 'idle');

  const rawCharacterAssets = Array.isArray(value.characterAssets) ? value.characterAssets : [];
  const characterAssets = rawCharacterAssets.flatMap((rawAsset): RenderCharacterAssetSnapshot[] => {
    if (!isRecord(rawAsset)) return [];
    const characterId = typeof rawAsset.characterId === 'string' ? rawAsset.characterId : '';
    if (!characterId) return [];
    const rawAssetState = typeof rawAsset.state === 'string' ? rawAsset.state.toLowerCase() : 'queued';
    const assetState = rawAssetState === 'running' ? 'working' : rawAssetState === 'completed' ? 'done' : rawAssetState;
    const state = ['queued', 'working', 'done', 'failed'].includes(assetState)
      ? assetState as RenderCharacterAssetSnapshot['state']
      : 'queued';
    return [{
      characterId,
      name: typeof rawAsset.name === 'string' && rawAsset.name ? rawAsset.name : '角色',
      state,
      progress: progressNumber(rawAsset.progress, state === 'done' ? 100 : 0),
      previewPath: typeof rawAsset.previewPath === 'string' && rawAsset.previewPath ? rawAsset.previewPath : undefined,
      generated: rawAsset.generated === true,
      cacheHit: rawAsset.cacheHit === true,
      seed: typeof rawAsset.seed === 'number' && Number.isFinite(rawAsset.seed) ? Math.trunc(rawAsset.seed) : undefined,
    }];
  });

  const rawScenes = Array.isArray(value.scenes) ? value.scenes : [];
  const scenes = rawScenes.flatMap((rawScene) => {
    if (!isRecord(rawScene)) return [];
    const sceneId = typeof rawScene.sceneId === 'string'
      ? rawScene.sceneId
      : typeof rawScene.id === 'string'
        ? rawScene.id
        : '';
    if (!sceneId) return [];
    const rawSceneState = typeof rawScene.state === 'string' ? rawScene.state.toLowerCase() : 'queued';
    const sceneState = rawSceneState === 'running' ? 'working' : rawSceneState === 'completed' ? 'done' : rawSceneState;
    const normalizedState = ['queued', 'working', 'done', 'failed'].includes(sceneState) ? sceneState as 'queued' | 'working' | 'done' | 'failed' : 'queued';
    const visualSource: RenderSceneSnapshot['visualSource'] = rawScene.visualSource === 'ai' || rawScene.visualSource === 'reference' || rawScene.visualSource === 'card'
      ? rawScene.visualSource
      : undefined;
    const voiceProfile = voiceProfiles.has(rawScene.voiceProfile as VoiceProfile)
      ? rawScene.voiceProfile as VoiceProfile
      : undefined;
    return [{
      sceneId,
      state: normalizedState,
      progress: progressNumber(rawScene.progress, normalizedState === 'done' ? 100 : 0),
      previewPath: typeof rawScene.previewPath === 'string' && rawScene.previewPath ? rawScene.previewPath : undefined,
      visualSource,
      voiceProfile,
    }];
  });
  const sceneIndex = Math.max(0, Math.trunc(finiteNumber(value.sceneIndex, 0)));
  const activeScene = scenes.find((scene) => scene.state === 'working') ?? scenes[sceneIndex];
  const activeSceneId = typeof value.activeSceneId === 'string' && value.activeSceneId
    ? value.activeSceneId
    : state === 'running' || state === 'pausing' || state === 'paused'
      ? activeScene?.sceneId
      : undefined;
  const rawError = value.error;
  const error = typeof rawError === 'string' && rawError
    ? { code: 'ENGINE_ERROR', message: rawError }
    : isRecord(rawError) && typeof rawError.message === 'string'
      ? {
          code: typeof rawError.code === 'string' ? rawError.code : 'ENGINE_ERROR',
          message: rawError.message,
          detail: typeof rawError.detail === 'string' ? rawError.detail : undefined,
        }
      : undefined;

  return {
    jobId,
    projectId,
    scope: value.scope === 'sample' || value.scope === 'scene' ? value.scope : 'full',
    state,
    stage,
    overallProgress: progressNumber(value.overallProgress, finiteNumber(value.progress, state === 'completed' ? 100 : 0)),
    sceneProgress: progressNumber(value.sceneProgress, activeScene?.progress ?? 0),
    elapsedSeconds: Math.max(0, finiteNumber(value.elapsedSeconds, 0)),
    activeSceneId,
    characterAssets,
    scenes,
    outputPath: typeof value.outputPath === 'string' && value.outputPath ? value.outputPath : undefined,
    outputBytes: typeof value.outputBytes === 'number' && Number.isFinite(value.outputBytes) ? Math.max(0, value.outputBytes) : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    error,
  };
}

function cloneSnapshot(snapshot: RenderJobSnapshot): RenderJobSnapshot {
  return {
    ...snapshot,
    scenes: snapshot.scenes.map((scene) => ({ ...scene })),
    error: snapshot.error ? { ...snapshot.error } : undefined,
  };
}

function advanceDemoJob(job: DemoJob): void {
  const snapshot = job.snapshot;
  if (snapshot.state === 'queued') {
    snapshot.state = 'running';
    snapshot.message = '瀏覽器 Demo 正在模擬本機引擎';
  }
  if (snapshot.state !== 'running') return;

  const now = Date.now();
  const ticks = Math.max(1, Math.floor((now - job.lastAdvancedAt) / demoTickMs));
  job.lastAdvancedAt = now;
  snapshot.elapsedSeconds += Math.max(1, Math.round((ticks * demoTickMs) / 1000));
  snapshot.overallProgress = Math.min(100, snapshot.overallProgress + ticks * demoProgressPerTick);

  if (snapshot.overallProgress >= 100) {
    snapshot.state = 'completed';
    snapshot.stage = 'complete';
    snapshot.sceneProgress = 100;
    snapshot.activeSceneId = undefined;
    snapshot.scenes = snapshot.scenes.map((scene) => ({ ...scene, state: 'done', progress: 100 }));
    snapshot.outputPath = '瀏覽器 Demo（未產生實體 MP4）';
    snapshot.outputBytes = 0;
    snapshot.message = '示範流程已完成；Windows App 才會產生實體 MP4。';
    return;
  }

  const sceneCount = Math.max(1, snapshot.scenes.length);
  const exactScene = (snapshot.overallProgress / 100) * sceneCount;
  const activeIndex = Math.min(sceneCount - 1, Math.floor(exactScene));
  const sceneProgress = (exactScene - activeIndex) * 100;
  const stageIndex = Math.min(demoStages.length - 1, Math.floor(sceneProgress / (100 / demoStages.length)));
  snapshot.stage = demoStages[stageIndex];
  snapshot.sceneProgress = sceneProgress;
  snapshot.activeSceneId = snapshot.scenes[activeIndex]?.sceneId;
  snapshot.scenes = snapshot.scenes.map((scene, index) => {
    if (index < activeIndex) return { ...scene, state: 'done', progress: 100 };
    if (index === activeIndex) return { ...scene, state: 'working', progress: sceneProgress };
    return { ...scene, state: 'queued', progress: 0 };
  });
}

export function isDemoBridge(): boolean {
  return !inTauri();
}

export async function getHardwareProfile(): Promise<HardwareProfile> {
  if (!inTauri()) return browserProfile;
  return normalizeHardwareProfile(await invoke<unknown>('get_hardware_profile'));
}

export async function startModelInstall(packId: string, acceptedLicenseIds: string[] = []): Promise<{ installId: string }> {
  if (!packId.trim()) throw new Error('缺少模型包識別碼。');
  if (!inTauri()) throw new Error('瀏覽器 Demo 無法安裝本機模型。');
  return invoke('start_model_install', { packId, acceptedLicenseIds });
}

export function normalizeModelInstallSnapshot(value: unknown): ModelInstallSnapshot {
  if (!isRecord(value) || typeof value.installId !== 'string' || !value.installId) {
    throw new Error('模型安裝器回傳了無效狀態。');
  }
  const state = typeof value.state === 'string' && modelInstallStates.has(value.state as ModelInstallSnapshot['state'])
    ? value.state as ModelInstallSnapshot['state']
    : 'failed';
  return {
    installId: value.installId,
    packId: typeof value.packId === 'string' && value.packId ? value.packId : undefined,
    packName: typeof value.packName === 'string' && value.packName ? value.packName : undefined,
    state,
    progress: progressNumber(value.progress, state === 'completed' ? 100 : 0),
    downloadedBytes: Math.max(0, finiteNumber(value.downloadedBytes, 0)),
    totalBytes: Math.max(0, finiteNumber(value.totalBytes, 0)),
    fileName: typeof value.fileName === 'string' ? value.fileName : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    error: typeof value.error === 'string'
      ? value.error
      : isRecord(value.error) && typeof value.error.message === 'string'
        ? value.error.message
        : undefined,
  };
}

export async function getModelInstall(installId: string): Promise<ModelInstallSnapshot> {
  if (!installId.trim()) throw new Error('缺少模型安裝工作識別碼。');
  if (!inTauri()) throw new Error('瀏覽器 Demo 沒有模型安裝工作。');
  return normalizeModelInstallSnapshot(await invoke<unknown>('get_model_install', { installId }));
}

export async function controlModelInstall(installId: string, action: 'cancel'): Promise<{ ok: boolean }> {
  if (!installId.trim()) throw new Error('缺少模型安裝工作識別碼。');
  if (!inTauri()) return { ok: false };
  return invoke('control_model_install', { installId, action });
}

function approximateDataUrlBytes(dataUrl: string): number {
  const encoded = dataUrl.split(',', 2)[1] ?? '';
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

export async function importReferenceAsset(dataUrl: string, fileName: string): Promise<ImportedReferenceAsset> {
  if (!dataUrl.startsWith('data:image/') || !dataUrl.includes(';base64,')) {
    throw new Error('參考圖格式無效。');
  }
  if (!inTauri()) {
    return { dataUrl, name: fileName || 'reference', bytes: approximateDataUrlBytes(dataUrl) };
  }
  const result = await invoke<ImportedReferenceAsset>('import_reference_asset', { dataUrl, fileName });
  if (!result || typeof result.path !== 'string' || !result.path || typeof result.name !== 'string') {
    throw new Error('本機參考圖匯入器回傳了無效結果。');
  }
  return result;
}

export async function readLocalImage(path: string): Promise<string> {
  if (!path.trim()) throw new Error('缺少本機圖片路徑。');
  if (!inTauri()) throw new Error('瀏覽器 Demo 無法讀取 Windows 本機圖片。');
  const existing = localImageCache.get(path);
  if (existing) return existing;
  const pending = invoke<string>('read_local_image', { path }).then((source) => {
    if (!source.startsWith('data:image/')) throw new Error('本機圖片讀取器回傳了無效內容。');
    return source;
  }).catch((error) => {
    localImageCache.delete(path);
    throw error;
  });
  localImageCache.set(path, pending);
  while (localImageCache.size > maxLocalImageCacheEntries) {
    const oldest = localImageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    localImageCache.delete(oldest);
  }
  return pending;
}

async function materializeEmbeddedReferenceAssets(project: EvolabsProject): Promise<EvolabsProject> {
  if (!inTauri() || !project.characters.some((character) => character.referenceImageDataUrl)) return project;
  let changed = false;
  const characters = await Promise.all(project.characters.map(async (character) => {
    if (!character.referenceImageDataUrl) return character;
    try {
      const imported = await importReferenceAsset(
        character.referenceImageDataUrl,
        character.referenceImageName || `${character.name || 'reference'}.png`,
      );
      changed = true;
      return {
        ...character,
        referenceImagePath: imported.path,
        referenceImageName: imported.name,
        referenceImageDataUrl: undefined,
      };
    } catch {
      // Keep a legacy embedded reference intact if migration cannot prove it is a
      // supported image. The user can still remove or replace it from the UI.
      return character;
    }
  }));
  return changed ? { ...project, characters } : project;
}

export async function loadProject(): Promise<EvolabsProject | null> {
  if (inTauri()) {
    const raw = await invoke<unknown>('load_last_project');
    if (raw === null) return null;
    const normalized = normalizeProject(raw);
    if (!normalized) throw new Error('儲存的專案格式無法辨識，已停止自動覆寫。');
    return materializeEmbeddedReferenceAssets(normalized);
  }
  const saved = localStorage.getItem(storageKey);
  if (!saved) return null;
  try {
    const normalized = normalizeProject(JSON.parse(saved));
    if (!normalized) throw new Error('invalid project schema');
    return normalized;
  } catch {
    throw new Error('儲存的專案格式無法辨識，已停止自動覆寫。');
  }
}

export async function saveProject(project: EvolabsProject): Promise<{ ok: boolean; savedAt: string }> {
  if (inTauri()) {
    const operation = projectSaveQueue
      .catch(() => undefined)
      .then(() => invoke<{ ok: boolean; savedAt: string }>('save_project', { project }));
    projectSaveQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  localStorage.setItem(storageKey, JSON.stringify(project));
  return { ok: true, savedAt: new Date().toISOString() };
}


export async function startAiRuntimeSetup(force = false): Promise<RuntimeSetupSnapshot> {
  if (inTauri()) return invoke<RuntimeSetupSnapshot>('start_ai_runtime_setup', { force });
  return {
    state: 'completed',
    stage: 'verify',
    progress: 100,
    title: '瀏覽器預覽已就緒',
    message: '瀏覽器模式不會安裝本機 AI 服務。',
    model: 'demo-fallback',
    updatedAtUnixMs: Date.now(),
    steps: [
      { id: 'system', title: '檢查電腦與核心', state: 'done', detail: '瀏覽器預覽' },
      { id: 'llmster', title: '準備 AI Agent 服務', state: 'done', detail: '瀏覽器預覽' },
      { id: 'model', title: '下載 Agent 大腦', state: 'done', detail: '瀏覽器預覽' },
      { id: 'load', title: '載入並最佳化', state: 'done', detail: '瀏覽器預覽' },
      { id: 'verify', title: '最終健康檢查', state: 'done', detail: '瀏覽器預覽' },
    ],
  };
}

export async function getAiRuntimeSetup(): Promise<RuntimeSetupSnapshot> {
  if (inTauri()) return invoke<RuntimeSetupSnapshot>('get_ai_runtime_setup');
  return startAiRuntimeSetup(false);
}

export async function startRuntimeSetup(): Promise<{ ok: boolean; message: string }> {
  if (inTauri()) return invoke('start_runtime_setup');
  return { ok: true, message: '瀏覽器 Demo 已就緒；此模式不會安裝模型。' };
}

export async function startRenderJob(project: EvolabsProject, sampleOnly: boolean, sceneId?: string): Promise<{ jobId: string }> {
  if (inTauri()) return invoke('start_render_job', { project, sampleOnly, sceneId });
  const selectedScenes = sceneId
    ? project.scenes.filter((scene) => scene.id === sceneId)
    : sampleOnly ? project.scenes.slice(0, 3) : project.scenes;
  if (!selectedScenes.length) throw new Error('至少需要一個分鏡才能開始生成。');
  const jobId = `demo_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  demoJobs.set(jobId, {
    lastAdvancedAt: Date.now(),
    snapshot: {
      jobId,
      projectId: project.id,
      scope: sceneId ? 'scene' : sampleOnly ? 'sample' : 'full',
      state: 'queued',
      stage: 'idle',
      overallProgress: 0,
      sceneProgress: 0,
      elapsedSeconds: 0,
      scenes: selectedScenes.map((scene) => ({ sceneId: scene.id, state: 'queued', progress: 0 })),
      message: '瀏覽器 Demo 佇列已建立',
    },
  });
  return { jobId };
}

export async function getRenderJob(jobId: string): Promise<RenderJobSnapshot> {
  if (inTauri()) return normalizeRenderJobSnapshot(await invoke<unknown>('get_render_job', { jobId }));
  const job = demoJobs.get(jobId);
  if (!job) throw new Error('找不到瀏覽器 Demo 生成工作。');
  advanceDemoJob(job);
  return cloneSnapshot(job.snapshot);
}

export async function controlRenderJob(jobId: string, action: RenderControlAction): Promise<{ ok: boolean }> {
  if (inTauri()) return invoke('control_render_job', { jobId, action });
  const job = demoJobs.get(jobId);
  if (!job) return { ok: false };
  if (action === 'pause' && (job.snapshot.state === 'queued' || job.snapshot.state === 'running')) {
    job.snapshot.state = 'paused';
    job.snapshot.message = '瀏覽器 Demo 已暫停';
  } else if (action === 'resume' && job.snapshot.state === 'paused') {
    job.snapshot.state = 'running';
    job.snapshot.message = '瀏覽器 Demo 已繼續';
    job.lastAdvancedAt = Date.now();
  } else if (action === 'cancel' && !['completed', 'failed', 'canceled'].includes(job.snapshot.state)) {
    job.snapshot.state = 'canceled';
    job.snapshot.activeSceneId = undefined;
    job.snapshot.message = '瀏覽器 Demo 已取消';
  } else {
    return { ok: false };
  }
  return { ok: true };
}

export async function revealRenderOutput(jobId: string): Promise<{ ok: boolean }> {
  if (inTauri()) return invoke('reveal_render_output', { jobId });
  return { ok: false };
}


export async function getAgentRuntime(): Promise<AgentRuntimeProfile> {
  if (!inTauri()) {
    return { available: false, provider: 'fallback', message: '瀏覽器預覽使用內建代理規劃器。' };
  }
  return invoke<AgentRuntimeProfile>('get_agent_runtime');
}

export async function runAgentStage(stage: AgentStage, project: EvolabsProject, context: unknown): Promise<unknown> {
  if (!project.story.trim()) throw new Error('請先貼上劇本。');
  if (!inTauri()) throw new Error('瀏覽器預覽沒有連接本機 LLM。');
  return invoke<unknown>('run_agent_stage', {
    stage,
    story: project.story,
    mode: project.settings.mode,
    targetSeconds: project.settings.targetSeconds,
    format: project.settings.format,
    context,
    directorInstructions: project.directorInstructions ?? [],
  });
}

/** Backward-compatible single-plan entry used by older tests and project builds. */
export async function runAgentPlan(project: EvolabsProject): Promise<unknown> {
  return runAgentStage('storyboard-artist', project, {
    script: project.productionBible?.script,
    artDirection: project.productionBible?.artDirection,
    ipBible: project.productionBible?.ipBible,
    characters: project.characters,
    locations: project.productionBible?.locations,
  });
}

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  if (!inTauri()) {
    return {
      configured: false,
      available: false,
      currentVersion: '0.6.0-preview',
      message: '瀏覽器預覽不會安裝桌面更新。',
    };
  }
  return invoke<AppUpdateInfo>('check_app_update');
}

export async function installAppUpdate(): Promise<{ ok: boolean; message: string }> {
  if (!inTauri()) return { ok: false, message: '瀏覽器預覽無法安裝桌面更新。' };
  return invoke('install_app_update');
}
