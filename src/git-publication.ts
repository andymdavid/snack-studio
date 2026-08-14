import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db } from './db.ts';
import { INTELLIGENCE_SNACKS_REPO, PUBLICATION_WORKTREE_DIR } from './config.ts';
import { getEpisode, recordAuditEvent } from './episodes.ts';
import { buildPublicationPackage } from './publication-package.ts';
import { getLatestWebsiteValidation } from './website-validation.ts';
import { gitEnvironment } from './git-auth.ts';

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, env: gitEnvironment() });
  const stdout = result.stdout.toString(); const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed\n${stderr || stdout}`.trim());
  return stdout.trim();
}

function mapPublication(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: String(row.id), episodeId: String(row.episode_id), validationAttemptId: String(row.validation_attempt_id),
    packageFingerprint: String(row.package_fingerprint), status: String(row.status), baseCommit: String(row.base_commit),
    commitSha: row.commit_sha == null ? null : String(row.commit_sha), commitMessage: String(row.commit_message),
    mainPushed: Boolean(row.main_pushed), cleanBuildOutput: row.clean_build_output == null ? null : String(row.clean_build_output),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export function getLatestGitPublication(episodeId: string) {
  return mapPublication(db.query('SELECT * FROM git_publication_attempts WHERE episode_id=?1 ORDER BY created_at DESC LIMIT 1').get(episodeId) as Record<string, unknown> | null);
}

export function validationAuthorizesPublication(packageFingerprint: string, validation: ReturnType<typeof getLatestWebsiteValidation>) {
  return Boolean(
    validation
    && validation.status === 'passed'
    && validation.packageFingerprint === packageFingerprint
    && validation.baseCommit
    && validation.worktreePath,
  );
}

export function publishValidatedPackageToMain(episodeId: string, actorPubkey: string) {
  const packageValue = buildPublicationPackage(episodeId);
  const validation = getLatestWebsiteValidation(episodeId);
  if (!packageValue.ready) throw new Error('The website package is no longer ready. Resolve its blockers and validate it again.');
  if (!validation || validation.status !== 'passed') throw new Error('A passing website validation is required before publication.');
  if (!validationAuthorizesPublication(packageValue.fingerprint, validation)) throw new Error('The package changed after validation. Validate it again before publishing.');
  if (!validation.baseCommit || !existsSync(validation.worktreePath)) throw new Error('The validated publication worktree is unavailable. Validate the package again.');
  const active = db.query("SELECT id FROM git_publication_attempts WHERE episode_id=?1 AND status IN ('committing','validating-commit','pushing-main') LIMIT 1").get(episodeId) as { id: string } | null;
  if (active) throw new Error('A publication attempt is already in progress for this episode.');
  const episode = getEpisode(episodeId);
  if (!episode) throw new Error('Episode not found.');
  const message = `Publish ${episode.publicTitle || episode.workingTitle}`.slice(0, 180);
  const attemptId = crypto.randomUUID(); const now = Date.now();
  db.query(`INSERT INTO git_publication_attempts(id,episode_id,validation_attempt_id,package_fingerprint,status,base_commit,commit_message,actor_pubkey,created_at,updated_at)
    VALUES(?1,?2,?3,?4,'committing',?5,?6,?7,?8,?8)`).run(attemptId, episodeId, validation.id, packageValue.fingerprint, validation.baseCommit, message, actorPubkey, now);
  try {
    run(['git', 'fetch', 'origin', 'main'], INTELLIGENCE_SNACKS_REPO);
    const currentMain = run(['git', 'rev-parse', 'origin/main'], INTELLIGENCE_SNACKS_REPO);
    if (currentMain !== validation.baseCommit) throw new Error('Intelligence Snacks main changed after validation. Validate the package again.');
    const paths = packageValue.files.map((file) => file.destination);
    run(['git', 'add', '--', ...paths], validation.worktreePath);
    const stagedOutsideManifest = run(['git', 'diff', '--cached', '--name-only'], validation.worktreePath).split('\n').filter(Boolean).filter((path) => !paths.includes(path));
    if (stagedOutsideManifest.length) throw new Error(`Publication contains files outside the manifest: ${stagedOutsideManifest.join(', ')}`);
    if (!run(['git', 'diff', '--cached', '--name-only'], validation.worktreePath)) throw new Error('The validated package does not contain any website changes.');
    run(['git', '-c', 'user.name=Snack Studio', '-c', 'user.email=studio@intelligencesnacks.com', 'commit', '-m', message], validation.worktreePath);
    const commitSha = run(['git', 'rev-parse', 'HEAD'], validation.worktreePath);
    db.query("UPDATE git_publication_attempts SET status='validating-commit',commit_sha=?1,updated_at=?2 WHERE id=?3").run(commitSha, Date.now(), attemptId);

    const cleanWorktree = resolve(PUBLICATION_WORKTREE_DIR, `clean-${attemptId}`); mkdirSync(dirname(cleanWorktree), { recursive: true });
    let cleanOutput = '';
    try {
      run(['git', 'worktree', 'add', '--detach', cleanWorktree, commitSha], INTELLIGENCE_SNACKS_REPO);
      const install = run(['bun', 'install', '--frozen-lockfile'], cleanWorktree);
      const build = run(['bun', 'run', 'build'], cleanWorktree);
      cleanOutput = `${install}\n${build}`.trim();
    } finally {
      if (existsSync(cleanWorktree)) {
        try { run(['git', 'worktree', 'remove', '--force', cleanWorktree], INTELLIGENCE_SNACKS_REPO); } catch {}
      }
    }
    db.query("UPDATE git_publication_attempts SET status='pushing-main',clean_build_output=?1,updated_at=?2 WHERE id=?3").run(cleanOutput.slice(0, 40_000), Date.now(), attemptId);
    run(['git', 'push', 'origin', `${commitSha}:main`], validation.worktreePath);
    const remoteMain = run(['git', 'ls-remote', 'origin', 'refs/heads/main'], validation.worktreePath).split(/\s+/)[0];
    if (remoteMain !== commitSha) throw new Error('The main push returned without the expected remote commit.');
    db.query("UPDATE git_publication_attempts SET status='published',main_pushed=1,updated_at=?1 WHERE id=?2").run(Date.now(), attemptId);
    recordAuditEvent({ actorPubkey, action: 'publication.main.pushed', entityType: 'episode', entityId: episodeId, detail: { attemptId, validationAttemptId: validation.id, commitSha, packageFingerprint: packageValue.fingerprint } });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    db.query("UPDATE git_publication_attempts SET status='failed',failure_summary=?1,updated_at=?2 WHERE id=?3").run(summary.slice(0, 4000), Date.now(), attemptId);
  }
  return getLatestGitPublication(episodeId)!;
}
