import { db } from './db.ts';
import { INTELLIGENCE_SNACKS_REPO } from './config.ts';
import { recordAuditEvent } from './episodes.ts';
import { getLatestGitPublication } from './git-publication.ts';
import { gitEnvironment } from './git-auth.ts';

function run(command: string[], cwd = INTELLIGENCE_SNACKS_REPO) {
  const result = Bun.spawnSync(command, { cwd, env: gitEnvironment() });
  const stdout = result.stdout.toString(); const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed\n${stderr || stdout}`.trim());
  return stdout.trim();
}

function isAncestor(ancestor: string, descendant: string) {
  return Bun.spawnSync(['git', 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: INTELLIGENCE_SNACKS_REPO, env: gitEnvironment() }).exitCode === 0;
}

function mapDeployment(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: String(row.id), episodeId: String(row.episode_id), publicationAttemptId: String(row.publication_attempt_id),
    status: String(row.status), sourceCommit: String(row.source_commit),
    previousDeployedCommit: row.previous_deployed_commit == null ? null : String(row.previous_deployed_commit),
    deployedPushed: Boolean(row.deployed_pushed), productionVerified: Boolean(row.production_verified),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export function getLatestGitDeployment(episodeId: string) {
  return mapDeployment(db.query('SELECT * FROM git_deployment_attempts WHERE episode_id=?1 ORDER BY created_at DESC LIMIT 1').get(episodeId) as Record<string, unknown> | null);
}

export function publicationAuthorizesDeployment(publication: ReturnType<typeof getLatestGitPublication>) {
  return Boolean(publication?.status === 'published' && publication.mainPushed && publication.commitSha);
}

export function deployPublishedCommit(episodeId: string, actorPubkey: string) {
  const publication = getLatestGitPublication(episodeId);
  if (!publicationAuthorizesDeployment(publication) || !publication?.commitSha) throw new Error('A commit published by Snack Studio to main is required before deployment.');
  const active = db.query("SELECT id FROM git_deployment_attempts WHERE episode_id=?1 AND status IN ('validating','pushing-deployed') LIMIT 1").get(episodeId) as { id: string } | null;
  if (active) throw new Error('A deployment attempt is already in progress for this episode.');
  const attemptId = crypto.randomUUID(); const now = Date.now();
  db.query(`INSERT INTO git_deployment_attempts(id,episode_id,publication_attempt_id,status,source_commit,actor_pubkey,created_at,updated_at)
    VALUES(?1,?2,?3,'validating',?4,?5,?6,?6)`).run(attemptId, episodeId, publication.id, publication.commitSha, actorPubkey, now);
  try {
    run(['git', 'fetch', 'origin', 'main', 'deployed']);
    const remoteMain = run(['git', 'rev-parse', 'origin/main']);
    const remoteDeployed = run(['git', 'rev-parse', 'origin/deployed']);
    db.query('UPDATE git_deployment_attempts SET previous_deployed_commit=?1,updated_at=?2 WHERE id=?3').run(remoteDeployed, Date.now(), attemptId);
    if (!isAncestor(publication.commitSha, remoteMain)) throw new Error('The selected publication commit is not present on website main.');
    if (!isAncestor(remoteDeployed, publication.commitSha)) throw new Error('The deployed branch cannot fast-forward to this publication commit.');
    db.query("UPDATE git_deployment_attempts SET status='pushing-deployed',updated_at=?1 WHERE id=?2").run(Date.now(), attemptId);
    run(['git', 'push', 'origin', `${publication.commitSha}:deployed`]);
    const deployedAfterPush = run(['git', 'ls-remote', 'origin', 'refs/heads/deployed']).split(/\s+/)[0];
    if (deployedAfterPush !== publication.commitSha) throw new Error('The deployed push returned without the expected remote commit.');
    db.query("UPDATE git_deployment_attempts SET status='deployed',deployed_pushed=1,updated_at=?1 WHERE id=?2").run(Date.now(), attemptId);
    recordAuditEvent({ actorPubkey, action: 'publication.deployed.pushed', entityType: 'episode', entityId: episodeId, detail: { attemptId, publicationAttemptId: publication.id, commitSha: publication.commitSha, previousDeployedCommit: remoteDeployed } });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    db.query("UPDATE git_deployment_attempts SET status='failed',failure_summary=?1,updated_at=?2 WHERE id=?3").run(summary.slice(0, 4000), Date.now(), attemptId);
  }
  return getLatestGitDeployment(episodeId)!;
}
