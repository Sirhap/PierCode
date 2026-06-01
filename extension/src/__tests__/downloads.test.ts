import { describe, expect, it } from 'vitest';
import {
  applyDownloadDelta,
  downloadItemToRecord,
  filterDownloadRecords,
  upsertDownloadRecord,
  type DownloadRecord,
} from '../background/downloads';

describe('download tracking helpers', () => {
  it('normalizes created download items', () => {
    const record = downloadItemToRecord({
      id: 7,
      url: 'https://example.com/file.pdf',
      finalUrl: 'https://cdn.example.com/file.pdf',
      filename: '/tmp/file.pdf',
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      startTime: '2026-05-31T00:00:00.000Z',
    } as chrome.downloads.DownloadItem);

    expect(record).toMatchObject({
      id: '7',
      url: 'https://cdn.example.com/file.pdf',
      filename: '/tmp/file.pdf',
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      startedAt: '2026-05-31T00:00:00.000Z',
    });
  });

  it('applies completion and interruption deltas', () => {
    const base: DownloadRecord = {
      id: '7',
      url: 'https://example.com/file.pdf',
      state: 'in_progress',
      startedAt: '2026-05-31T00:00:00.000Z',
    };

    const complete = applyDownloadDelta(base, {
      id: 7,
      state: { current: 'complete', previous: 'in_progress' },
      filename: { current: '/tmp/file.pdf', previous: '' },
    } as chrome.downloads.DownloadDelta, new Date('2026-05-31T00:01:00.000Z'));

    expect(complete).toMatchObject({
      state: 'complete',
      filename: '/tmp/file.pdf',
      endedAt: '2026-05-31T00:01:00.000Z',
    });

    const interrupted = applyDownloadDelta(base, {
      id: 7,
      state: { current: 'interrupted', previous: 'in_progress' },
      error: { current: 'NETWORK_FAILED', previous: '' },
    } as chrome.downloads.DownloadDelta, new Date('2026-05-31T00:02:00.000Z'));

    expect(interrupted).toMatchObject({
      state: 'interrupted',
      error: 'NETWORK_FAILED',
      endedAt: '2026-05-31T00:02:00.000Z',
    });
  });

  it('keeps recent records first and truncates history', () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      state: 'complete' as const,
    }));
    const next = upsertDownloadRecord(records, { id: 'new', state: 'in_progress' });

    expect(next).toHaveLength(100);
    expect(next[0].id).toBe('new');
    expect(next.some(item => item.id === '99')).toBe(false);
  });

  it('filters by state and limit', () => {
    const records: DownloadRecord[] = [
      { id: '1', state: 'complete' },
      { id: '2', state: 'in_progress' },
      { id: '3', state: 'complete' },
    ];

    expect(filterDownloadRecords(records, 'complete', 1)).toEqual({
      downloads: [{ id: '1', state: 'complete' }],
      count: 1,
      total: 2,
      truncated: true,
    });
  });
});
