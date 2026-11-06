import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export type PublishedSnack = { slug: string; title: string; standfirst: string; sourceEpisode: string; candidateId?: string | undefined; revisionId?: string | undefined; editorialTitle?: string | undefined };
export function readPublishedSnacks(repo: string): PublishedSnack[] {
  const directory = join(repo, 'src/content/snacks');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => /\.mdx?$/.test(name)).flatMap((name) => {
    const text = readFileSync(join(directory, name), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!header) throw new Error(`Missing Snack frontmatter: ${name}`);
    const value = Bun.YAML.parse(header) as Record<string, string>;
    return value.status === 'published' ? [{ slug: name.replace(/\.mdx?$/, ''), title: value.title!, standfirst: value.standfirst!, sourceEpisode: value.sourceEpisode!, candidateId: value.studioCandidateId, revisionId: value.studioRevisionId, editorialTitle: value.editorialTitle }] : [];
  });
}
export function resolvePublishedSnack(candidate: { candidateId: string; title: string; standfirst: string; episodeNumber: number | null }, manifest: PublishedSnack[]) {
  const episode = `episode-${String(candidate.episodeNumber).padStart(3, '0')}`;
  const explicit = manifest.filter((item) => item.candidateId === candidate.candidateId);
  if (explicit.length > 1) throw new Error(`Duplicate published candidate ${candidate.candidateId}`);
  if (explicit.length) return explicit[0];
  // Legacy snapshots have no Studio identity. Require an exact, unique match in the source episode.
  const matches = manifest.filter((item) => !item.candidateId && item.sourceEpisode === episode && (item.title === candidate.title || item.editorialTitle === candidate.title || item.standfirst === candidate.standfirst));
  if (matches.length > 1) throw new Error(`Ambiguous published Snack ${candidate.candidateId}`);
  return matches[0] || null;
}
