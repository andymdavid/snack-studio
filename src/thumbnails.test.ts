import { describe, expect, test } from 'bun:test';
import { db } from './db.ts';
import { episodeThumbnailTemplate, episodeTitleAccentY, thumbnailPipelineRoute, verifyThumbnailCallbackToken, verifyThumbnailGenerationTrigger } from './thumbnails.ts';

describe('thumbnail generation trigger verification', () => {
  test('rejects a prepared route mismatch without throwing for an episode job', () => {
    const job = db.query("SELECT id FROM thumbnail_jobs WHERE asset_kind='episode' LIMIT 1").get() as { id: string };
    const id = job.id;
    expect(verifyThumbnailGenerationTrigger(id, { url:'http://localhost:3600/api/pipelines/triggers/http/snack-studio-snack-thumbnail.v4', method:'POST', body:{ input:{ jobId:id, webhook:{ token:'wrong' } } } })).toBe(false);
  });

  test('rejects an invalid thumbnail callback credential', () => {
    const job = db.query("SELECT id FROM thumbnail_jobs WHERE asset_kind='episode' LIMIT 1").get() as { id: string };
    expect(verifyThumbnailCallbackToken(job.id, 'not-the-callback-token')).toBe(false);
  });

  test('pins the current episode-thumbnail pipeline route', () => {
    expect(thumbnailPipelineRoute('episode')).toEqual({
      pipeline: 'snack-studio-episode-thumbnail',
      version: '10',
      path: '/snack-studio-episode-thumbnail.v10',
    });
  });

  test('selects the guest layout whenever a non-host contributor is present', () => {
    expect(episodeThumbnailTemplate(['pete-winn', 'andy-david'])).toBe('two-hosts');
    expect(episodeThumbnailTemplate(['pete-winn', 'rod-bishop', 'andy-david'])).toBe('two-hosts-plus-guest');
  });

  test('positions the guest accent line from the rendered lead line instead of a fixed canvas coordinate', () => {
    expect(episodeTitleAccentY('two-hosts-plus-guest', 205, 151)).toBe(384);
    expect(episodeTitleAccentY('two-hosts-plus-guest', 205, 227)).toBe(460);
    expect(episodeTitleAccentY('two-hosts', 200, 112)).toBe(335);
  });
});
