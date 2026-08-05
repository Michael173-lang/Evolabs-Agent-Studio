import { invoke } from '@tauri-apps/api/core';
import type {
  ManagedComfyUiState,
  ManagedComfyUiStatus,
  ManagedComfyUiStep,
  StorageActionResult,
  StorageCleanupResult,
  StorageItem,
  StorageItemKind,
  StorageOverview,
} from '../types';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

const comfyStates = new Set<ManagedComfyUiState>([
  'not-installed',
  'idle',
  'installing',
  'starting',
  'running',
  'repairing',
  'uninstalling',
  'failed',
]);

const stepIds = new Set<ManagedComfyUiStep['id']>(['system', 'download', 'extract', 'launch', 'verify']);
const stepStates = new Set<ManagedComfyUiStep['state']>(['queued', 'working', 'done', 'failed']);
const storageKinds = new Set<StorageItemKind>([
  'managed-runtime',
  'video-model',
  'legacy-model',
  'download-cache',
  'render-output',
  'render-cache',
  'temporary',
  'reference',
  'configuration',
]);

const browserComfyStatus: ManagedComfyUiStatus = {
  installed: false,
  running: false,
  available: false,
  state: 'not-installed',
  progress: 0,
  message: '瀏覽器預覽無法管理本機 AI 影片引擎。',
  downloadedBytes: 0,
  totalBytes: 0,
  installedBytes: 0,
  endpoint: 'http://127.0.0.1:8188',
  steps: [],
};

const browserStorage: StorageOverview = {
  rootPath: '',
  driveName: '瀏覽器預覽',
  driveTotalBytes: 0,
  driveFreeBytes: 0,
  evolabsBytes: 0,
  modelBytes: 0,
  cacheBytes: 0,
  outputBytes: 0,
  temporaryBytes: 0,
  scannedAt: new Date().toISOString(),
  truncated: false,
  items: [],
};

function normalizeStep(value: unknown): ManagedComfyUiStep | null {
  if (!isRecord(value)) return null;
  const id = text(value.id) as ManagedComfyUiStep['id'];
  const state = text(value.state) as ManagedComfyUiStep['state'];
  if (!stepIds.has(id) || !stepStates.has(state)) return null;
  return {
    id,
    state,
    title: text(value.title, id),
    detail: text(value.detail),
  };
}

export function normalizeManagedComfyUiStatus(value: unknown): ManagedComfyUiStatus {
  if (!isRecord(value)) return browserComfyStatus;
  const stateCandidate = text(value.state) as ManagedComfyUiState;
  const state = comfyStates.has(stateCandidate) ? stateCandidate : 'failed';
  return {
    installed: value.installed === true,
    running: value.running === true,
    available: value.available === true,
    state,
    progress: Math.max(0, Math.min(100, Math.round(number(value.progress)))),
    message: text(value.message, 'AI 影片引擎狀態未知。'),
    installPath: text(value.installPath) || undefined,
    version: text(value.version) || undefined,
    processId: number(value.processId, -1) >= 0 ? Math.round(number(value.processId)) : undefined,
    downloadedBytes: Math.max(0, number(value.downloadedBytes)),
    totalBytes: Math.max(0, number(value.totalBytes)),
    installedBytes: Math.max(0, number(value.installedBytes)),
    endpoint: text(value.endpoint, 'http://127.0.0.1:8188'),
    error: text(value.error) || undefined,
    steps: Array.isArray(value.steps) ? value.steps.flatMap((entry) => {
      const step = normalizeStep(entry);
      return step ? [step] : [];
    }) : [],
    updatedAt: text(value.updatedAt) || undefined,
  };
}

function normalizeStorageItem(value: unknown): StorageItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const kind = text(value.kind) as StorageItemKind;
  if (!id || !storageKinds.has(kind)) return null;
  return {
    id,
    name: text(value.name, id),
    description: text(value.description),
    kind,
    path: text(value.path),
    bytes: Math.max(0, number(value.bytes)),
    fileCount: Math.max(0, Math.round(number(value.fileCount))),
    removable: value.removable === true,
    active: value.active === true,
    legacy: value.legacy === true,
    version: text(value.version) || undefined,
    modifiedAt: text(value.modifiedAt) || undefined,
    warning: text(value.warning) || undefined,
  };
}

export function normalizeStorageOverview(value: unknown): StorageOverview {
  if (!isRecord(value)) return browserStorage;
  return {
    rootPath: text(value.rootPath),
    driveName: text(value.driveName, '目前磁碟'),
    driveTotalBytes: Math.max(0, number(value.driveTotalBytes)),
    driveFreeBytes: Math.max(0, number(value.driveFreeBytes)),
    evolabsBytes: Math.max(0, number(value.evolabsBytes)),
    modelBytes: Math.max(0, number(value.modelBytes)),
    cacheBytes: Math.max(0, number(value.cacheBytes)),
    outputBytes: Math.max(0, number(value.outputBytes)),
    temporaryBytes: Math.max(0, number(value.temporaryBytes)),
    scannedAt: text(value.scannedAt, new Date().toISOString()),
    truncated: value.truncated === true,
    items: Array.isArray(value.items) ? value.items.flatMap((entry) => {
      const item = normalizeStorageItem(entry);
      return item ? [item] : [];
    }) : [],
  };
}

function requireDesktop(message: string): void {
  if (!inTauri()) throw new Error(message);
}

export async function getManagedComfyUiStatus(): Promise<ManagedComfyUiStatus> {
  if (!inTauri()) return browserComfyStatus;
  return normalizeManagedComfyUiStatus(await invoke<unknown>('get_managed_comfyui_status'));
}

export async function installManagedComfyUi(): Promise<ManagedComfyUiStatus> {
  requireDesktop('瀏覽器預覽無法安裝本機 AI 影片引擎。');
  return normalizeManagedComfyUiStatus(await invoke<unknown>('install_managed_comfyui'));
}

export async function repairManagedComfyUi(): Promise<ManagedComfyUiStatus> {
  requireDesktop('瀏覽器預覽無法修復本機 AI 影片引擎。');
  return normalizeManagedComfyUiStatus(await invoke<unknown>('repair_managed_comfyui'));
}

export async function startManagedComfyUi(): Promise<ManagedComfyUiStatus> {
  requireDesktop('瀏覽器預覽無法啟動本機 AI 影片引擎。');
  return normalizeManagedComfyUiStatus(await invoke<unknown>('start_managed_comfyui'));
}

export async function stopManagedComfyUi(): Promise<ManagedComfyUiStatus> {
  requireDesktop('瀏覽器預覽無法停止本機 AI 影片引擎。');
  return normalizeManagedComfyUiStatus(await invoke<unknown>('stop_managed_comfyui'));
}

export async function uninstallManagedComfyUi(preserveModels: boolean): Promise<StorageActionResult> {
  requireDesktop('瀏覽器預覽無法解除安裝本機 AI 影片引擎。');
  return invoke<StorageActionResult>('uninstall_managed_comfyui', { preserveModels });
}

export async function getStorageOverview(): Promise<StorageOverview> {
  if (!inTauri()) return browserStorage;
  return normalizeStorageOverview(await invoke<unknown>('get_storage_overview'));
}

export async function removeStorageItem(itemId: string, confirmation: string): Promise<StorageOverview> {
  requireDesktop('瀏覽器預覽無法刪除本機檔案。');
  return normalizeStorageOverview(await invoke<unknown>('remove_storage_item', { itemId, confirmation }));
}

export async function revealStorageItem(itemId: string): Promise<void> {
  requireDesktop('瀏覽器預覽無法開啟本機資料夾。');
  await invoke('reveal_storage_item', { itemId });
}

export async function removeOldModelVersions(): Promise<StorageCleanupResult> {
  requireDesktop('瀏覽器預覽無法刪除本機模型檔案。');
  const value = await invoke<unknown>('remove_old_model_versions', { confirmation: '清除舊版本' });
  if (!isRecord(value)) throw new Error('儲存清理結果格式無效。');
  return {
    message: text(value.message, '舊模型版本清理完成。'),
    freedBytes: Math.max(0, number(value.freedBytes)),
    overview: normalizeStorageOverview(value.overview),
  };
}
