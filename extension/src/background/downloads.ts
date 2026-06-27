export const DOWNLOAD_STORAGE_KEY = 'piercodeRecentDownloads';
export const MAX_DOWNLOAD_RECORDS = 100;

export type DownloadState = 'in_progress' | 'complete' | 'interrupted';

export type DownloadRecord = {
  id: string;
  url?: string;
  filename?: string;
  state: DownloadState;
  error?: string;
  bytesReceived?: number;
  totalBytes?: number;
  startedAt?: string;
  endedAt?: string;
};

export function downloadItemToRecord(item: chrome.downloads.DownloadItem, now = new Date()): DownloadRecord {
  return {
    id: String(item.id),
    url: item.finalUrl || item.url || undefined,
    filename: item.filename || undefined,
    state: normalizeState(item.state),
    error: item.error || undefined,
    bytesReceived: finiteNumber(item.bytesReceived),
    totalBytes: finiteNumber(item.totalBytes),
    startedAt: item.startTime || now.toISOString(),
    endedAt: item.endTime || undefined,
  };
}

export function applyDownloadDelta(record: DownloadRecord, delta: chrome.downloads.DownloadDelta, now = new Date()): DownloadRecord {
  const next: DownloadRecord = { ...record };
  if (delta.url?.current) next.url = delta.url.current;
  if (delta.finalUrl?.current) next.url = delta.finalUrl.current;
  if (delta.filename?.current) next.filename = delta.filename.current;
  if (delta.error?.current) next.error = delta.error.current;
  if (delta.totalBytes?.current != null) next.totalBytes = finiteNumber(delta.totalBytes.current);
  if (delta.state?.current) {
    next.state = normalizeState(delta.state.current);
    if (next.state === 'complete' || next.state === 'interrupted') {
      next.endedAt = next.endedAt || now.toISOString();
    }
    // chrome.downloads.DownloadDelta carries no bytesReceived field, so a
    // delta-only update would otherwise leave bytesReceived stale at its last
    // value (audit #18). A completed download has received all of its bytes, so
    // pin progress to totalBytes; getRecentDownloads re-queries search() for
    // live in-progress byte counts.
    if (next.state === 'complete' && next.totalBytes != null) {
      next.bytesReceived = next.totalBytes;
    }
  }
  return next;
}

export function upsertDownloadRecord(records: DownloadRecord[], record: DownloadRecord, max = MAX_DOWNLOAD_RECORDS): DownloadRecord[] {
  const filtered = records.filter(item => item.id !== record.id);
  return [record, ...filtered].slice(0, max);
}

export function filterDownloadRecords(records: DownloadRecord[], state: string, limit: number) {
  const normalizedState = state === 'complete' || state === 'interrupted' || state === 'in_progress' ? state : 'all';
  const safeLimit = Math.max(1, Math.min(MAX_DOWNLOAD_RECORDS, Math.floor(limit || 20)));
  const filtered = normalizedState === 'all'
    ? records
    : records.filter(item => item.state === normalizedState);
  const downloads = filtered.slice(0, safeLimit);
  return {
    downloads,
    count: downloads.length,
    total: filtered.length,
    truncated: filtered.length > safeLimit,
  };
}

function normalizeState(state: string | undefined): DownloadState {
  if (state === 'complete' || state === 'interrupted') return state;
  return 'in_progress';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
