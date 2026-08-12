import { describe, expect, test } from 'bun:test';
import { db } from './db.ts';
import { thumbnailPipelineRoute, verifyThumbnailGenerationTrigger } from './thumbnails.ts';

describe('thumbnail generation trigger verification', () => {
  test('rejects a prepared route mismatch without throwing for an episode job', () => {
    const job = db.query("SELECT id FROM thumbnail_jobs WHERE asset_kind='episode' LIMIT 1").get() as { id: string };
    const id = job.id;
    expect(verifyThumbnailGenerationTrigger(id, { url:'http://localhost:3600/api/pipelines/triggers/http/snack-studio-snack-thumbnail.v3', method:'POST', body:{ input:{ jobId:id, webhook:{ token:'wrong' } } } })).toBe(false);
  });

  test('pins the current episode-thumbnail pipeline route', () => {
    expect(thumbnailPipelineRoute('episode')).toEqual({
      pipeline: 'snack-studio-episode-thumbnail',
      version: '4',
      path: '/snack-studio-episode-thumbnail.v4',
    });
  });
});
