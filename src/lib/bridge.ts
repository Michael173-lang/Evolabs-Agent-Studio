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
  gpu: '瀏覽器預覽未偵測硬體',
  vramMb: 0,
  ramGb: 0,
  cpu: '瀏覽器預覽',
  profile: 'low-vram',
  runtimeReady: false,
  runtimeVersion: '0.8.0-beta.1-preview',
  aiReady: false,
  aiProvider: undefined,
  capabilities: {
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
  },
  modelPacks: [],
};

const renderJobStates = new Set<RenderJobSnapshot['state']>(['queued', 'running', 'awaiting-review', 'pausing', 'paused', 'canceling', 'canceled', 'failed', 'completed']);
const renderStages = new Set<RenderStage>(['idle', 'visual', 'motion', 'voice', 'review', 'compose', 'complete']);
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
    trueVideoGeneration: rawCapabilities?.trueVideoGeneration === true,
    videoProviderConfigured: rawCapabilities?.videoProviderConfigured === true,
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
    const normalizedState = ['queued', 'working', 'review', 'done', 'failed'].includes(sceneState) ? sceneState as RenderSceneSnapshot['state'] : 'queued';
    const rawVisualSource = String(rawScene.visualSource ?? '');
    const visualSource: RenderSceneSnapshot['visualSource'] = rawVisualSource === 'video'
      ? 'video'
      : rawVisualSource === 'reference'
        ? 'reference'
        : ['ai', 'card', 'motion-comic'].includes(rawVisualSource)
          ? 'motion-comic'
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
      generationAttempt: typeof rawScene.generationAttempt === 'number' ? Math.max(0, Math.trunc(rawScene.generationAttempt)) : undefined,
      reviewState: ['pending', 'approved', 'rejected'].includes(String(rawScene.reviewState))
        ? rawScene.reviewState as RenderSceneSnapshot['reviewState']
        : undefined,
      reviewFeedback: typeof rawScene.reviewFeedback === 'string' ? rawScene.reviewFeedback : undefined,
      qualityChecks: Array.isArray(rawScene.qualityChecks)
        ? rawScene.qualityChecks.flatMap((check) => {
            if (!isRecord(check) || typeof check.id !== 'string' || typeof check.label !== 'string' || typeof check.detail !== 'string') return [];
            const state = ['passed', 'warning', 'failed', 'pending', 'unavailable'].includes(String(check.state))
              ? check.state as 'passed' | 'warning' | 'failed' | 'pending' | 'unavailable'
              : 'unavailable';
            return [{ id: check.id as any, label: check.label, state, detail: check.detail }];
          })
        : undefined,
      providerId: typeof rawScene.providerId === 'string' ? rawScene.providerId : undefined,
      modelName: typeof rawScene.modelName === 'string' ? rawScene.modelName : undefined,
    }];
  });
  const sceneIndex = Math.max(0, Math.trunc(finiteNumber(value.sceneIndex, 0)));
  const activeScene = scenes.find((scene) => scene.state === 'working') ?? scenes[sceneIndex];
  const activeSceneId = typeof value.activeSceneId === 'string' && value.activeSceneId
    ? value.activeSceneId
    : state === 'running' || state === 'awaiting-review' || state === 'pausing' || state === 'paused'
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

export function isDemoBridge(): boolean {
  return !inTauri();
}

export async function getHardwareProfile(): Promise<HardwareProfile> {
  if (!inTauri()) return browserProfile;
  return normalizeHardwareProfile(await invoke<unknown>('get_hardware_profile'));
}

export async function startModelInstall(packId: string, acceptedLicenseIds: string[] = []): Promise<{ installId: string }> {
  if (!packId.trim()) throw new Error('缺少模型包識別碼。');
  if (!inTauri()) throw new Error('瀏覽器預覽無法安裝本機模型。');
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
  if (!inTauri()) throw new Error('瀏覽器預覽沒有模型安裝工作。');
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
  if (!inTauri()) throw new Error('瀏覽器預覽無法讀取 Windows 本機圖片。');
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
    state: 'failed',
    stage: 'verify',
    progress: 0,
    title: '桌面 Runtime 未連線',
    message: '瀏覽器預覽不會模擬 Agent Runtime。請使用 Evolabs 桌面版。',
    error: 'TAURI_DESKTOP_REQUIRED',
    updatedAtUnixMs: Date.now(),
    steps: [
      { id: 'system', title: '檢查桌面環境', state: 'failed', detail: '目前是瀏覽器預覽' },
      { id: 'llmster', title: '啟動 Agent 服務', state: 'queued', detail: '等待桌面版' },
      { id: 'model', title: '準備 Agent 模型', state: 'queued', detail: '等待桌面版' },
      { id: 'load', title: '載入模型', state: 'queued', detail: '等待桌面版' },
      { id: 'verify', title: '驗證模型回覆', state: 'queued', detail: '等待桌面版' },
    ],
  };
}

export async function getAiRuntimeSetup(): Promise<RuntimeSetupSnapshot> {
  if (inTauri()) return invoke<RuntimeSetupSnapshot>('get_ai_runtime_setup');
  return startAiRuntimeSetup(false);
}

export async function startRuntimeSetup(): Promise<{ ok: boolean; message: string }> {
  if (inTauri()) return invoke('start_runtime_setup');
  return { ok: false, message: '瀏覽器預覽不會模擬本機 Runtime。' };
}

export async function startRenderJob(project: EvolabsProject, sampleOnly: boolean, sceneId?: string): Promise<{ jobId: string }> {
  if (!inTauri()) throw new Error('瀏覽器預覽不會模擬影片生成。請使用桌面版。');
  return invoke('start_render_job', { project, sampleOnly, sceneId });
}

export async function getRenderJob(jobId: string): Promise<RenderJobSnapshot> {
  if (!inTauri()) throw new Error('瀏覽器預覽沒有影片生成工作。');
  return normalizeRenderJobSnapshot(await invoke<unknown>('get_render_job', { jobId }));
}

export async function controlRenderJob(jobId: string, action: RenderControlAction): Promise<{ ok: boolean }> {
  if (!inTauri()) return { ok: false };
  return invoke('control_render_job', { jobId, action });
}

export async function reviewRenderScene(
  jobId: string,
  sceneId: string,
  approved: boolean,
  feedback = '',
): Promise<{ ok: boolean; message?: string }> {
  if (!inTauri()) throw new Error('瀏覽器預覽不能審核本機影片鏡頭。');
  return invoke('review_render_scene', { jobId, sceneId, approved, feedback });
}

export async function revealRenderOutput(jobId: string): Promise<{ ok: boolean }> {
  if (inTauri()) return invoke('reveal_render_output', { jobId });
  return { ok: false };
}


export async function getAgentRuntime(): Promise<AgentRuntimeProfile> {
  if (!inTauri()) {
    return { available: false, provider: 'unavailable', message: '瀏覽器預覽不會模擬 Agent 回覆。' };
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
      currentVersion: '0.8.0-beta.1-preview',
      message: '瀏覽器預覽不會安裝桌面更新。',
    };
  }
  return invoke<AppUpdateInfo>('check_app_update');
}

export async function installAppUpdate(): Promise<{ ok: boolean; message: string }> {
  if (!inTauri()) return { ok: false, message: '瀏覽器預覽無法安裝桌面更新。' };
  return invoke('install_app_update');
}
