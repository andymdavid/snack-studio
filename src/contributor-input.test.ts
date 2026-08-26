import { describe, expect, test } from 'bun:test';
import { contributorSlug, validateContributorPhoto, validateContributorProfile } from './contributor-input.ts';

describe('contributor profile input', () => {
  test('derives a stable website-compatible slug and aliases', () => {
    const form = new FormData();
    form.set('name', 'José Example');
    form.set('role', 'Episode 65 guest');
    form.set('shortBio', 'Builds useful systems.');
    form.set('biographyMarkdown', 'José works on useful systems.');
    form.set('aliases', 'José, J. Example');
    const value = validateContributorProfile(form);
    expect(value.id).toBe('jose-example');
    expect(value.aliases).toEqual(['José Example', 'José', 'J. Example']);
  });

  test('retains the source transcript label when the public name is corrected', () => {
    const form = new FormData();
    form.set('name', 'Jarrad Grigg');
    form.set('speakerAlias', 'Jarad');
    form.set('role', 'Episode 53 guest');
    form.set('shortBio', 'Builds software products.');
    form.set('biographyMarkdown', 'Jarrad builds software products.');
    form.set('aliases', 'Jarrad');
    expect(validateContributorProfile(form).aliases).toEqual(['Jarrad Grigg', 'Jarad', 'Jarrad']);
  });

  test('allows a private placeholder profile with only a name', () => {
    const form = new FormData();
    form.set('name', 'Private Guest');
    expect(validateContributorProfile(form)).toMatchObject({
      id: 'private-guest', name: 'Private Guest', role: '', shortBio: '', biographyMarkdown: '',
    });
  });

  test('rejects unsafe social URLs', () => {
    const form = new FormData();
    form.set('name', 'Guest'); form.set('role', 'Guest'); form.set('shortBio', 'Bio'); form.set('biographyMarkdown', 'About');
    form.set('xUrl', 'javascript:alert(1)');
    expect(() => validateContributorProfile(form)).toThrow('X profile must use http or https');
  });

  test('accepts supported identity photos', () => {
    expect(() => validateContributorPhoto(new File(['image'], 'guest.webp', { type: 'image/webp' }))).not.toThrow();
    expect(contributorSlug('  Ada Lovelace  ')).toBe('ada-lovelace');
  });
});
