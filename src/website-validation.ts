import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { db } from './db.ts';
import { INTELLIGENCE_SNACKS_REPO, PUBLICATION_WORKTREE_DIR } from './config.ts';
import { buildPublicationPackage, type PublicationPackageFile } from './publication-package.ts';
import { recordAuditEvent } from './episodes.ts';

const ALLOWED_DESTINATIONS = [
  'src/content/episodes/', 'src/content/snacks/', 'src/content/people/', 'src/content/topics/',
  'src/content/newsletters/', 'src/content/transcripts/', 'public/images/episodes/', 'public/images/snacks/', 'public/images/',
] as const;

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, env: process.env });
  const stdout = result.stdout.toString(); const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed\n${stderr || stdout}`.trim());
  return stdout.trim();
}

function yamlString(value: string) { return JSON.stringify(value); }
function yamlOptional(label: string, value: string | null | undefined) { return value ? `${label}: ${yamlString(value)}\n` : ''; }
function yamlList(label: string, input: Array<string | undefined>) { const values = input.filter((value): value is string => Boolean(value)); return `${label}:${values.length ? `\n${values.map((value) => `  - ${value}`).join('\n')}` : ' []'}\n`; }

function renderEpisode(value: ReturnType<typeof buildPublicationPackage>['episode']) {
  return `---\nnumber: ${value.number}\ntitle: ${yamlString(value.title)}\nsummary: ${yamlString(value.summary || '')}\nthumbnail: ${yamlString(value.thumbnail || '')}\nstatus: ${value.status}\n${yamlList('participants', value.participants)}${yamlList('themes', value.themes)}${yamlOptional('originalPublishedAt', value.recordedOn)}${yamlOptional('youtubeUrl', value.youtubeUrl)}${yamlOptional('audioUrl', value.audioUrl)}transcript: ${value.transcript}\nfeatured: false\nfixture: false\n---\n\n${value.summary || ''}\n`;
}

function renderSnack(value: ReturnType<typeof buildPublicationPackage>['snacks'][number], episodeSlug: string, relationships: ReturnType<typeof buildPublicationPackage>['relationships']) {
  const related = relationships.filter((item) => item.sourceCandidateId === value.candidateId);
  const relationshipYaml = related.length ? `relationships:\n${related.map((item) => `  - target: ${item.targetSlug}\n    type: ${item.type}${item.note ? `\n    note: ${yamlString(item.note)}` : ''}`).join('\n')}\n` : 'relationships: []\n';
  return `---\ntitle: ${yamlString(value.title)}\n${yamlOptional('editorialTitle', value.editorialTitle)}thumbnail: ${yamlString(value.thumbnail || '')}\nstandfirst: ${yamlString(value.standfirst)}\nstatus: published\nsourceEpisode: ${episodeSlug}\nepisodePosition: ${value.position}\ntheme: ${value.theme}\nattribution: ${yamlString(value.attribution || '')}\n${yamlOptional('transcriptStart', value.transcriptStart)}${relationshipYaml}featured: false\nfixture: false\n${value.seo.title || value.seo.description ? `seo:\n${value.seo.title ? `  title: ${yamlString(value.seo.title)}\n` : ''}${value.seo.description ? `  description: ${yamlString(value.seo.description)}\n` : ''}` : ''}---\n\n${value.bodyMarkdown.trim()}\n`;
}

function renderNewsletter(value: NonNullable<ReturnType<typeof buildPublicationPackage>['newsletter']>) {
  return `---\ntitle: ${yamlString(value.title)}\nstatus: published\nsourceEpisode: ${value.sourceEpisode}\n${yamlList('snacks', value.snacks)}---\n\nA curated selection from this episode of Intelligence Snacks.\n`;
}

function renderTheme(value: ReturnType<typeof buildPublicationPackage>['themes'][number]) {
  return `---\nname: ${yamlString(value.name)}\ndescription: ${yamlString(value.description)}\ncolour: ${yamlString(value.colour)}\nfeatured: false\n---\n\n${value.description}\n`;
}

function renderPerson(value: ReturnType<typeof buildPublicationPackage>['people'][number]) {
  const links = Object.entries(value.socialLinks).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return `---\nname: ${yamlString(value.name)}\nrole: ${yamlString(value.role)}\nshortBio: ${yamlString(value.shortBio)}\nimage: ${yamlString(value.image)}\n${yamlOptional('externalUrl', value.externalUrl)}${links.length ? `socialLinks:\n${links.map(([key, url]) => `  ${key}: ${yamlString(url)}`).join('\n')}\n` : ''}---\n\n${value.biographyMarkdown.trim()}\n`;
}

function safeDestination(worktree: string, relative: string) {
  if (isAbsolute(relative) || relative.includes('..') || !ALLOWED_DESTINATIONS.some((prefix) => relative.startsWith(prefix))) throw new Error(`Publication destination is not allowed: ${relative}`);
  const destination = resolve(worktree, relative);
  const root = `${resolve(worktree)}${sep}`;
  if (!destination.startsWith(root)) throw new Error(`Publication destination escapes the worktree: ${relative}`);
  return destination;
}

function copyAsset(file: PublicationPackageFile, worktree: string) {
  if (!file.sourcePath || !existsSync(file.sourcePath)) throw new Error(`Approved asset source is missing for ${file.destination}`);
  const destination = safeDestination(worktree, file.destination); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file.sourcePath, destination);
}

export function getLatestWebsiteValidation(episodeId: string) {
  const row = db.query('SELECT * FROM website_validation_attempts WHERE episode_id=?1 ORDER BY created_at DESC LIMIT 1').get(episodeId) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: String(row.id), episodeId: String(row.episode_id), packageFingerprint: String(row.package_fingerprint), status: String(row.status),
    websiteRepo: String(row.website_repo), worktreePath: String(row.worktree_path), baseCommit: row.base_commit == null ? null : String(row.base_commit),
    changedFiles: JSON.parse(String(row.changed_files_json || '[]')), diffStat: row.diff_stat == null ? null : String(row.diff_stat),
    textDiff: row.text_diff == null ? null : String(row.text_diff), buildOutput: row.build_output == null ? null : String(row.build_output),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export function stageAndValidateWebsitePackage(episodeId: string, actorPubkey: string) {
  const packageValue = buildPublicationPackage(episodeId);
  if (!packageValue.ready) throw new Error(`Website package is not ready: ${packageValue.blockers.map((item) => item.message).join(' ')}`);
  if (!existsSync(join(INTELLIGENCE_SNACKS_REPO, '.git'))) throw new Error('Intelligence Snacks repository is unavailable');
  const attemptId = crypto.randomUUID(); const now = Date.now();
  const worktree = resolve(PUBLICATION_WORKTREE_DIR, `${episodeId}-${attemptId}`); mkdirSync(dirname(worktree), { recursive: true });
  db.query(`INSERT INTO website_validation_attempts(id,episode_id,package_fingerprint,status,website_repo,worktree_path,package_json,actor_pubkey,created_at,updated_at)
    VALUES(?1,?2,?3,'staging',?4,?5,?6,?7,?8,?8)`).run(attemptId, episodeId, packageValue.fingerprint, INTELLIGENCE_SNACKS_REPO, worktree, JSON.stringify(packageValue), actorPubkey, now);
  try {
    run(['git', 'fetch', 'origin', 'main'], INTELLIGENCE_SNACKS_REPO);
    const baseCommit = run(['git', 'rev-parse', 'origin/main'], INTELLIGENCE_SNACKS_REPO);
    run(['git', 'worktree', 'add', '--detach', worktree, baseCommit], INTELLIGENCE_SNACKS_REPO);
    const snacks = new Map(packageValue.snacks.map((snack) => [snack.revisionId, snack]));
    const people = new Map(packageValue.people.map((person) => [person.id, person]));
    const themes = new Map(packageValue.themes.map((theme) => [theme.id, theme]));
    for (const file of packageValue.files) {
      const destination = safeDestination(worktree, file.destination); mkdirSync(dirname(destination), { recursive: true });
      if (file.kind === 'episode') writeFileSync(destination, renderEpisode(packageValue.episode));
      else if (file.kind === 'snack') writeFileSync(destination, renderSnack(snacks.get(file.sourceRevisionId!)!, packageValue.episode.slug, packageValue.relationships));
      else if (file.kind === 'person') writeFileSync(destination, renderPerson(people.get(file.sourceId)!));
      else if (file.kind === 'theme') writeFileSync(destination, renderTheme(themes.get(file.sourceId)!));
      else if (file.kind === 'newsletter') writeFileSync(destination, renderNewsletter(packageValue.newsletter!));
      else if (file.kind === 'transcript') writeFileSync(destination, `${packageValue.transcript!.transcriptText.trim()}\n`);
      else copyAsset(file, worktree);
    }
    db.query("UPDATE website_validation_attempts SET status='validating',base_commit=?1,updated_at=?2 WHERE id=?3").run(baseCommit, Date.now(), attemptId);
    const installOutput = run(['bun', 'install', '--frozen-lockfile'], worktree);
    const buildOutput = run(['bun', 'run', 'build'], worktree);
    const changedFiles = run(['git', 'status', '--short'], worktree).split('\n').filter(Boolean);
    run(['git', 'add', '-N', '--', ...packageValue.files.map((file) => file.destination)], worktree);
    const diffStat = run(['git', 'diff', '--stat', '--', ...packageValue.files.map((file) => file.destination)], worktree);
    const textPaths = packageValue.files.filter((file) => ['episode','snack','person','theme','newsletter','transcript'].includes(file.kind)).map((file) => file.destination);
    const textDiff = textPaths.length ? run(['git', 'diff', '--', ...textPaths], worktree) : '';
    db.query(`UPDATE website_validation_attempts SET status='passed',changed_files_json=?1,diff_stat=?2,text_diff=?3,build_output=?4,updated_at=?5 WHERE id=?6`)
      .run(JSON.stringify(changedFiles), diffStat, textDiff.slice(0, 100_000), `${installOutput}\n${buildOutput}`.trim().slice(0, 40_000), Date.now(), attemptId);
    recordAuditEvent({ actorPubkey, action: 'publication.website.validated', entityType: 'episode', entityId: episodeId, detail: { attemptId, packageFingerprint: packageValue.fingerprint, baseCommit, changedFileCount: changedFiles.length } });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    db.query("UPDATE website_validation_attempts SET status='failed',failure_summary=?1,updated_at=?2 WHERE id=?3").run(summary.slice(0, 4000), Date.now(), attemptId);
  }
  return getLatestWebsiteValidation(episodeId)!;
}
