import { invoke } from '@tauri-apps/api/core';
import type { AgentStage, EvolabsProject } from '../types';

export interface AgentModelDescriptor {
  id: string;
  name: string;
  loaded: boolean;
  recommended: boolean;
  family?: string;
  contextLength?: number;
}

export interface AgentModelCatalog {
  available: boolean;
  provider: 'lm-studio' | 'fallback';
  endpoint?: string;
  selectedModel?: string;
  models: AgentModelDescriptor[];
  message: string;
}

const browserCatalog: AgentModelCatalog = {
  available: false,
  provider: 'fallback',
  models: [],
  message: '瀏覽器預覽未連接本機模型；桌面版會列出 Runtime 已載入的模型。',
};

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCatalog(value: unknown): AgentModelCatalog {
  if (!isRecord(value)) return browserCatalog;
  const models = Array.isArray(value.models)
    ? value.models.flatMap((entry): AgentModelDescriptor[] => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return [];
        return [{
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
          loaded: entry.loaded !== false,
          recommended: entry.recommended === true,
          family: typeof entry.family === 'string' ? entry.family : undefined,
          contextLength: typeof entry.contextLength === 'number' && Number.isFinite(entry.contextLength)
            ? Math.max(0, Math.round(entry.contextLength))
            : undefined,
        }];
      })
    : [];
  return {
    available: value.available === true,
    provider: value.provider === 'lm-studio' ? 'lm-studio' : 'fallback',
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : undefined,
    selectedModel: typeof value.selectedModel === 'string' ? value.selectedModel : undefined,
    models,
    message: typeof value.message === 'string' ? value.message : '本機模型狀態未知。',
  };
}

export function isDesktopStudio(): boolean {
  return inTauri();
}

export async function getAgentModels(): Promise<AgentModelCatalog> {
  if (!inTauri()) return browserCatalog;
  return normalizeCatalog(await invoke<unknown>('get_agent_models'));
}

export async function runAgentStageV2(
  stage: AgentStage,
  project: EvolabsProject,
  context: unknown,
  modelId = 'auto',
): Promise<unknown> {
  if (!project.story.trim()) throw new Error('請先貼上劇本。');
  if (!inTauri()) throw new Error('瀏覽器預覽沒有連接本機 LLM。');
  return invoke<unknown>('run_agent_stage_v2', {
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
