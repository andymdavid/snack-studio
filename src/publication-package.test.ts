import { describe, expect, test } from 'bun:test';
import { deriveEpisodeTopics, episodePublicationSlug, publicationSlug } from './publication-package.ts';

describe('website publication package paths', () => {
  test('derives stable website collection slugs', () => {
    expect(publicationSlug('AI Speed Makes Architectural Judgement More Important')).toBe('ai-speed-makes-architectural-judgement-more-important');
    expect(publicationSlug('That’s useful: isn’t it?')).toBe('thats-useful-isnt-it');
  });

  test('pads episode numbers to the website convention', () => {
    expect(episodePublicationSlug(64)).toBe('episode-064');
    expect(episodePublicationSlug(649)).toBe('episode-649');
  });
});

describe('episode topic compatibility', () => {
  test('derives the website primary reference from Snack themes without editor input', () => {
    expect(deriveEpisodeTopics(['agents', 'software-systems', 'agents'])).toEqual({ primaryTopic: 'agents', relatedTopics: ['software-systems'] });
  });
});
