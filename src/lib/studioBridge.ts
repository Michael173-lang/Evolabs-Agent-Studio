import { invoke } from '@tauri-apps/api/core';
import type {
  AgentConversationResponse,
  AgentId,
  AgentModelCatalog,
  AgentModelDescriptor,
  AgentModelTestResult,
  AgentStage,
  AgentStageResponse,
  EvolabsProject,
  VideoProviderCapabilities,
  VideoProviderStatus,
} from '../types';

const unavailableCatalog: AgentModelCatalog = {
  available: false,
  provider: 'unavailable',
  models: [],
  message: '瀏覽器預覽不會模擬本機 AI。請使用 Evolabs 桌面版並啟動本機 AI 執行環境。',
};

const unavailableVideoProvider: VideoProviderStatus = {
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
  message: '瀏覽器預覽不會模擬影片模型服務。',
};

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeModel(entry: unknown): AgentModelDescriptor | null {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return null;
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
    loaded: entry.loaded !== false,
    recommended: entry.recommended === true,
    family: typeof entry.family === 'string' ? entry.family : undefined,
    contextLength: typeof entry.contextLength === 'number' && Number.isFinite(entry.contextLength)
      ? Math.max(0, Math.round(entry.contextLength))
      : undefined,
  };
}

function normalizeCatalog(value: unknown): AgentModelCatalog {
  if (!isRecord(value)) return unavailableCatalog;
  return {
    available: value.available === true,
    provider: value.provider === 'lm-studio' ? 'lm-studio' : 'unavailable',
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : undefined,
    selectedModel: typeof value.selectedModel === 'string' ? value.selectedModel : undefined,
    models: Array.isArray(value.models) ? value.models.flatMap((entry) => {
      const model = normalizeModel(entry);
      return model ? [model] : [];
    }) : [],
    message: typeof value.message === 'string' ? value.message : '本機 Agent 狀態未知。',
  };
}

function normalizeCapabilities(value: unknown): VideoProviderCapabilities {
  const raw = isRecord(value) ? value : {};
  return {
    textToVideo: raw.textToVideo === true,
    imageToVideo: raw.imageToVideo === true,
    outputVideo: raw.outputVideo === true,
    promptBinding: raw.promptBinding === true,
    negativePromptBinding: raw.negativePromptBinding === true,
    seedBinding: raw.seedBinding === true,
    dimensionsBinding: raw.dimensionsBinding === true,
    frameBinding: raw.frameBinding === true,
    fpsBinding: raw.fpsBinding === true,
    inputImageBinding: raw.inputImageBinding === true,
    outputPrefixBinding: raw.outputPrefixBinding === true,
  };
}

function normalizeVideoProvider(value: unknown): VideoProviderStatus {
  if (!isRecord(value)) return unavailableVideoProvider;
  const compatibility = ['unsupported', 'experimental', 'recommended', 'unknown'].includes(String(value.compatibility))
    ? value.compatibility as VideoProviderStatus['compatibility']
    : 'unknown';
  return {
    configured: value.configured === true,
    available: value.available === true,
    providerId: typeof value.providerId === 'string' ? value.providerId : undefined,
    kind: value.kind === 'comfyui' ? 'comfyui' : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : undefined,
    workflowName: typeof value.workflowName === 'string' ? value.workflowName : undefined,
    workflowValid: value.workflowValid === true,
    nodeCount: Math.max(0, Math.round(finite(value.nodeCount))),
    capabilities: normalizeCapabilities(value.capabilities),
    detectedModels: Array.isArray(value.detectedModels)
      ? value.detectedModels.filter((entry): entry is string => typeof entry === 'string').slice(0, 64)
      : [],
    compatibility,
    message: typeof value.message === 'string' ? value.message : '影片模型服務狀態未知。',
    lastVerifiedAt: typeof value.lastVerifiedAt === 'string' ? value.lastVerifiedAt : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

function requireDesktop(message: string): void {
  if (!inTauri()) throw new Error(message);
}

export function isDesktopStudio(): boolean {
  return inTauri();
}

export async function getAgentModels(): Promise<AgentModelCatalog> {
  if (!inTauri()) return unavailableCatalog;
  return normalizeCatalog(await invoke<unknown>('get_agent_models'));
}

export async function testAgentModel(modelId = 'auto'): Promise<AgentModelTestResult> {
  requireDesktop('瀏覽器預覽沒有連接本機 Agent 模型。');
  return invoke<AgentModelTestResult>('test_agent_model', {
    modelId: modelId === 'auto' ? null : modelId,
  });
}

export async function runAgentStageV3<T>(
  stage: AgentStage,
  project: EvolabsProject,
  context: unknown,
  modelId = 'auto',
): Promise<AgentStageResponse<T>> {
  if (!project.story.trim()) throw new Error('請先輸入劇本。');
  requireDesktop('瀏覽器預覽沒有連接本機 Agent 模型。');
  return invoke<AgentStageResponse<T>>('run_agent_stage_v3', {
    stage,
    story: project.story,
    mode: project.settings.mode,
    targetSeconds: project.settings.targetSeconds,
    format: project.settings.format,
    context,
    directorInstructions: project.directorInstructions ?? [],
    modelId: modelId === 'auto' ? null : modelId,
  });
}

export async function runAgentConversation(
  agentId: AgentId,
  userMessage: string,
  projectContext: unknown,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  modelId = 'auto',
): Promise<AgentConversationResponse> {
  if (!userMessage.trim()) throw new Error('請輸入要傳給 Agent 的訊息。');
  requireDesktop('瀏覽器預覽沒有連接本機 Agent 模型。');
  return invoke<AgentConversationResponse>('run_agent_conversation', {
    agentId,
    userMessage,
    projectContext,
    conversationHistory,
    modelId: modelId === 'auto' ? null : modelId,
  });
}

export async function getVideoProviderStatus(): Promise<VideoProviderStatus> {
  if (!inTauri()) return unavailableVideoProvider;
  return normalizeVideoProvider(await invoke<unknown>('get_video_provider_status'));
}

export async function configureComfyUiProvider(
  endpoint: string,
  workflowName: string,
  workflow: unknown,
): Promise<VideoProviderStatus> {
  requireDesktop('瀏覽器預覽不能設定本機影片模型服務。');
  if (!isRecord(workflow)) throw new Error('請匯入 ComfyUI 的 API 格式 JSON 工作流。');
  return normalizeVideoProvider(await invoke<unknown>('configure_comfyui_provider', {
    request: { endpoint, workflowName, workflow },
  }));
}

export async function clearVideoProvider(): Promise<{ ok: boolean }> {
  requireDesktop('瀏覽器預覽不能修改本機影片模型服務。');
  return invoke<{ ok: boolean }>('clear_video_provider');
}
