import {
  AlertTriangle,
  ArchiveX,
  Database,
  FolderOpen,
  HardDrive,
  PackageX,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { StorageItem, StorageOverview } from '../types';
import { ProgressBar, StatusPill } from './ui';

interface StoragePanelProps {
  overview: StorageOverview | null;
  busy: string;
  onRefresh: () => void;
  onRemove: (itemId: string, confirmation: string) => Promise<void>;
  onRemoveOldVersions: () => Promise<void>;
  onReveal: (itemId: string) => void;
  onOpenModels: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function kindLabel(item: StorageItem): string {
  switch (item.kind) {
    case 'managed-runtime': return 'AI 影片引擎';
    case 'video-model': return '影片模型';
    case 'legacy-model': return item.legacy ? '舊模型版本' : '參考圖模型';
    case 'download-cache': return '下載快取';
    case 'render-output': return '生成輸出';
    case 'render-cache': return '生成快取';
    case 'temporary': return '暫存資料';
    case 'reference': return '參考素材';
    default: return '應用資料';
  }
}

export default function StoragePanel({
  overview,
  busy,
  onRefresh,
  onRemove,
  onRemoveOldVersions,
  onReveal,
  onOpenModels,
}: StoragePanelProps) {
  const scanning = busy === 'storage-scan';
  const oldVersions = overview?.items.filter((item) => item.legacy && !item.active) ?? [];
  const oldVersionBytes = oldVersions.reduce((sum, item) => sum + item.bytes, 0);
  const diskUsed = overview?.driveTotalBytes
    ? Math.max(0, overview.driveTotalBytes - overview.driveFreeBytes)
    : 0;
  const diskUsedPercent = overview?.driveTotalBytes
    ? Math.min(100, (diskUsed / overview.driveTotalBytes) * 100)
    : 0;
  const lowSpace = Boolean(overview && overview.driveFreeBytes > 0 && overview.driveFreeBytes < 15 * 1024 ** 3);

  const remove = async (item: StorageItem) => {
    const warning = item.warning ? `\n\n${item.warning}` : '';
    const activeWarning = item.active ? '\n\n這是目前啟用的元件或模型；移除後相關功能會暫停。' : '';
    const action = item.kind === 'video-model' || item.kind === 'legacy-model' ? '解除安裝' : '刪除';
    if (!window.confirm(`確定要${action}「${item.name}」並釋放 ${formatBytes(item.bytes)}？${warning}${activeWarning}\n\n此操作無法在 Evolabs 內復原。`)) return;
    await onRemove(item.id, item.name);
  };

  return (
    <section className="panel settings-section storage-section">
      <div className="settings-section__header storage-section__header">
        <HardDrive size={19} />
        <div><span className="eyebrow">儲存空間與元件</span><h2>空間管理</h2></div>
        <button className="button button--secondary button--compact" type="button" disabled={Boolean(busy)} onClick={onRefresh}>
          {scanning ? <span className="spinner" /> : <RefreshCw size={15} />} {scanning ? '掃描中' : '重新掃描'}
        </button>
      </div>

      {!overview ? (
        <div className="storage-loading"><span className="spinner" /><p>正在統計 Evolabs、模型、輸出與快取占用。</p></div>
      ) : (
        <>
          <div className="storage-disk">
            <div className="storage-disk__headline">
              <div><strong>{overview.driveName || '目前磁碟'}</strong><small>可用 {formatBytes(overview.driveFreeBytes)} / 總容量 {formatBytes(overview.driveTotalBytes)}</small></div>
              <StatusPill tone={lowSpace ? 'danger' : diskUsedPercent > 85 ? 'warning' : 'good'}>{diskUsedPercent.toFixed(0)}% 已使用</StatusPill>
            </div>
            <ProgressBar value={diskUsedPercent} />
            {lowSpace && (
              <div className="inline-alert storage-warning"><AlertTriangle size={17} /><span>磁碟可用空間低於 15 GB。建議優先移除未啟用的舊模型版本、下載快取與不再需要的生成輸出。</span></div>
            )}
          </div>

          <div className="storage-summary-grid">
            <div><span>Evolabs 總占用</span><strong>{formatBytes(overview.evolabsBytes)}</strong></div>
            <div><span>模型</span><strong>{formatBytes(overview.modelBytes)}</strong></div>
            <div><span>快取</span><strong>{formatBytes(overview.cacheBytes)}</strong></div>
            <div><span>生成輸出</span><strong>{formatBytes(overview.outputBytes)}</strong></div>
            <div><span>暫存資料</span><strong>{formatBytes(overview.temporaryBytes)}</strong></div>
            <div><span>項目數</span><strong>{overview.items.length}</strong></div>
          </div>

          <div className="storage-quick-clean">
            <div>
              <ArchiveX size={18} />
              <span><strong>未啟用的舊模型版本</strong><small>{oldVersions.length ? `${oldVersions.length} 個版本，共 ${formatBytes(oldVersionBytes)}` : '目前沒有可清除的舊版本。'}</small></span>
            </div>
            <button className="button button--danger" type="button" disabled={!oldVersions.length || Boolean(busy)} onClick={() => {
              if (window.confirm(`清除 ${oldVersions.length} 個未啟用的舊模型版本，預計釋放 ${formatBytes(oldVersionBytes)}？\n\n目前啟用的版本不會被刪除。`)) void onRemoveOldVersions();
            }}>
              <Trash2 size={15} /> 清除舊版本
            </button>
          </div>

          {overview.truncated && (
            <p className="form-note form-note--warning">檔案數量較多，本次統計已達安全掃描上限。畫面數字可能略低於實際占用。</p>
          )}

          <div className="storage-item-list">
            {overview.items.map((item) => {
              const itemBusy = busy === `storage-remove:${item.id}`;
              return (
                <article className="storage-item" key={item.id}>
                  <div className="storage-item__icon">{item.kind === 'video-model' || item.kind === 'legacy-model' ? <Database size={18} /> : item.kind === 'managed-runtime' ? <PackageX size={18} /> : <HardDrive size={18} />}</div>
                  <div className="storage-item__copy">
                    <div className="storage-item__title">
                      <strong>{item.name}</strong>
                      <StatusPill tone={item.active ? 'good' : item.legacy ? 'warning' : 'neutral'}>{item.kind === 'video-model' ? '已安裝' : item.active ? '目前使用' : kindLabel(item)}</StatusPill>
                    </div>
                    <p>{item.description}</p>
                    <small>{formatBytes(item.bytes)} · {item.fileCount.toLocaleString()} 個檔案{item.version ? ` · 版本 ${item.version}` : ''}</small>
                    <small className="identifier storage-item__path">{item.path}</small>
                    {item.warning && <small className="storage-item__warning">{item.warning}</small>}
                  </div>
                  <div className="storage-item__actions">
                    <button className="button button--ghost button--compact" type="button" disabled={Boolean(busy)} onClick={() => onReveal(item.id)}><FolderOpen size={14} /> 開啟位置</button>
                    {item.kind === 'managed-runtime' ? (
                      <button className="button button--secondary button--compact" type="button" onClick={onOpenModels}>管理引擎</button>
                    ) : item.removable ? (
                      <button className="button button--danger button--compact" type="button" disabled={Boolean(busy)} onClick={() => void remove(item)}>
                        {itemBusy ? <span className="spinner" /> : <Trash2 size={14} />} {item.kind === 'video-model' || item.kind === 'legacy-model' ? '解除安裝' : '刪除'}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="form-note">Evolabs 只會刪除已掃描且位於應用程式管理目錄內的項目，不會接受任意檔案路徑。</p>
        </>
      )}
    </section>
  );
}
