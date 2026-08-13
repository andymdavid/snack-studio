import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { episodePublicationSlug, publicationSlug, resolvePublicationAssetSource } from './publication-package.ts';

describe('website publication package paths', () => {
  test('derives stable website collection slugs', () => {
    expect(publicationSlug('AI Speed Makes Architectural Judgement More Important')).toBe('ai-speed-makes-architectural-judgement-more-important');
    expect(publicationSlug('That’s useful: isn’t it?')).toBe('thats-useful-isnt-it');
  });

  test('pads episode numbers to the website convention', () => {
    expect(episodePublicationSlug(64)).toBe('episode-064');
    expect(episodePublicationSlug(649)).toBe('episode-649');
  });

  test('maps approved public portrait URLs back to their local source asset', () => {
    expect(resolvePublicationAssetSource('/images/contributors/generated/anthony-voxel.webp'))
      .toBe(resolve('public/images/contributors/generated/anthony-voxel.webp'));
  });
});
