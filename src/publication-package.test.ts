import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { episodePublicationSlug, publicationSlug, resolvePublicationAssetSource, websiteThemeNeedsPublication } from './publication-package.ts';

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

  test('publishes a referenced theme when the website file is absent regardless of seed source', () => {
    const root = `/tmp/snack-studio-publication-package-${crypto.randomUUID()}`;
    mkdirSync(join(root, 'src/content/topics'), { recursive: true });
    expect(websiteThemeNeedsPublication('privacy-security', root)).toBe(true);
    writeFileSync(join(root, 'src/content/topics/privacy-security.md'), '---\nname: Privacy & Security\n---\n');
    expect(websiteThemeNeedsPublication('privacy-security', root)).toBe(false);
  });
});
