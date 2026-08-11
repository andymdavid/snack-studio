export type ContributorProfileInput = {
  id: string;
  name: string;
  role: string;
  shortBio: string;
  biographyMarkdown: string;
  aliases: string[];
  externalUrl: string | null;
  xUrl: string | null;
  linkedinUrl: string | null;
  nostrUrl: string | null;
};

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalUrl(value: string, label: string): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use http or https`);
  return url.href;
}

export function contributorSlug(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function validateContributorProfile(form: FormData): ContributorProfileInput {
  const name = text(form.get('name'));
  const id = contributorSlug(text(form.get('id')) || name);
  const role = text(form.get('role'));
  const shortBio = text(form.get('shortBio'));
  const biographyMarkdown = text(form.get('biographyMarkdown'));
  if (!name) throw new Error('Contributor name is required');
  if (!id) throw new Error('Contributor ID could not be derived from the name');
  if (!role) throw new Error('Contributor role is required');
  if (!shortBio) throw new Error('Short bio is required');
  if (!biographyMarkdown) throw new Error('Biography is required');
  const aliases = [...new Set([name, ...text(form.get('aliases')).split(',')].map((item) => item.trim()).filter(Boolean))];
  return {
    id, name, role, shortBio, biographyMarkdown, aliases,
    externalUrl: optionalUrl(text(form.get('externalUrl')), 'Website'),
    xUrl: optionalUrl(text(form.get('xUrl')), 'X profile'),
    linkedinUrl: optionalUrl(text(form.get('linkedinUrl')), 'LinkedIn profile'),
    nostrUrl: optionalUrl(text(form.get('nostrUrl')), 'Nostr profile'),
  };
}

export function validateContributorPhoto(file: File): void {
  if (!file.size) throw new Error('A reference photo is required');
  if (file.size > 12 * 1024 * 1024) throw new Error('Reference photo must be 12 MB or smaller');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Reference photo must be JPEG, PNG or WebP');
}
