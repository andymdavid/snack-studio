import { getActiveTranscriptRevision, getEpisode, listEpisodes } from './episodes.ts';
import { listCandidates, validateApprovedCandidateBatch } from './candidates.ts';
import { listEpisodePipelineRequests } from './pipeline-requests.ts';
import { buildPublicationPackage } from './publication-package.ts';
import { getLatestWebsiteValidation } from './website-validation.ts';
import { getLatestGitPublication } from './git-publication.ts';
import { getLatestGitDeployment } from './git-deployment.ts';
import { getPublicationPreparation } from './thumbnails.ts';

const ACTIVE = new Set(['created', 'awaiting-authorization', 'queued', 'running', 'applying-result']);
const FAILED = new Set(['failed', 'timed-out', 'needs-review']);

export type EpisodeWorkflowPhase = 'needs-transcript' | 'generating' | 'generation-failed' | 'snack-review' | 'final-set-ready'
  | 'publication-preparing' | 'asset-review' | 'publication-blocked' | 'ready-to-validate' | 'validated' | 'published-main' | 'deployed';

type WorkflowInput = {
  hasTranscript: boolean; candidateCount: number; episodeApproved: boolean; finalSetReady: boolean;
  generationStatus: string | null; publicationActive: boolean; assetReviewCount: number;
  packageReady: boolean; blockers: Array<{ code: string; message: string }>;
  validationCurrent: boolean; publicationCurrent: boolean; deploymentCurrent: boolean;
};

export function deriveEpisodeWorkflow(input: WorkflowInput) {
  let phase: EpisodeWorkflowPhase; let status: string; let action: { label: string; route: string } | null;
  if (!input.hasTranscript) { phase = 'needs-transcript'; status = 'Transcript needed'; action = { label: 'Upload transcript', route: 'episode' }; }
  else if (input.generationStatus && ACTIVE.has(input.generationStatus) && !input.candidateCount) { phase = 'generating'; status = 'Generating Snacks'; action = null; }
  else if (input.generationStatus && FAILED.has(input.generationStatus) && !input.candidateCount) { phase = 'generation-failed'; status = 'Generation needs attention'; action = { label: 'Retry generation', route: 'episode' }; }
  else if (!input.episodeApproved && input.finalSetReady) { phase = 'final-set-ready'; status = 'Final set ready'; action = { label: 'Approve final set', route: 'review' }; }
  else if (!input.episodeApproved) { phase = 'snack-review'; status = 'Snack review'; action = { label: 'Review Snacks', route: 'review' }; }
  else if (input.deploymentCurrent) { phase = 'deployed'; status = 'Deployed'; action = null; }
  else if (input.publicationCurrent) { phase = 'published-main'; status = 'Published to main'; action = { label: 'Deploy website', route: 'publications' }; }
  else if (input.validationCurrent) { phase = 'validated'; status = 'Validated'; action = { label: 'Publish to main', route: 'publications' }; }
  else if (input.packageReady) { phase = 'ready-to-validate'; status = 'Ready to validate'; action = { label: 'Validate publication', route: 'publications' }; }
  else if (input.assetReviewCount) { phase = 'asset-review'; status = `${input.assetReviewCount} item${input.assetReviewCount === 1 ? '' : 's'} to review`; action = { label: 'Review outstanding items', route: 'review' }; }
  else if (input.publicationActive) { phase = 'publication-preparing'; status = 'Preparing publication'; action = null; }
  else { phase = 'publication-blocked'; status = input.blockers[0]?.message || 'Publication needs attention'; action = { label: 'Complete publication', route: 'publications' }; }
  return { phase, status, recommendedAction: action };
}

export function getEpisodeWorkflow(episodeId: string) {
  const episode = getEpisode(episodeId); if (!episode) throw new Error('Episode not found');
  const transcript = getActiveTranscriptRevision(episodeId);
  const candidates = listCandidates(episodeId);
  const approved = validateApprovedCandidateBatch(episodeId);
  const requests = listEpisodePipelineRequests(episodeId);
  const generation = requests.find((item) => item.operation === 'transcript-to-snacks') || null;
  const publicationActive = requests.some((item) => item.operation === 'publication-metadata' && ACTIVE.has(item.status));
  let packageValue: ReturnType<typeof buildPublicationPackage> | null = null;
  let assetReviewCount = 0;
  if (episode.status === 'approved') {
    packageValue = buildPublicationPackage(episodeId);
    try { assetReviewCount = getPublicationPreparation(episodeId).jobs.filter((job) => job.status === 'in-review').length; } catch {}
  }
  const validation = getLatestWebsiteValidation(episodeId);
  const publication = getLatestGitPublication(episodeId);
  const deployment = getLatestGitDeployment(episodeId);
  const fingerprint = packageValue?.fingerprint || null;
  const validationCurrent = Boolean(fingerprint && validation?.status === 'passed' && validation.packageFingerprint === fingerprint);
  const publicationCurrent = Boolean(validationCurrent && publication?.status === 'published' && publication.mainPushed && publication.packageFingerprint === fingerprint);
  const deploymentCurrent = Boolean(publicationCurrent && deployment?.status === 'deployed' && deployment.deployedPushed && deployment.publicationAttemptId === publication?.id);
  return {
    episodeId, episodeNumber: episode.episodeNumber, title: episode.publicTitle || episode.workingTitle,
    ...deriveEpisodeWorkflow({
      hasTranscript: Boolean(transcript), candidateCount: candidates.length, episodeApproved: episode.status === 'approved', finalSetReady: approved.ready,
      generationStatus: generation?.status || null, publicationActive, assetReviewCount,
      packageReady: Boolean(packageValue?.ready), blockers: packageValue?.blockers || [], validationCurrent, publicationCurrent, deploymentCurrent,
    }),
    blockers: packageValue?.blockers || [], updatedAt: episode.updatedAt,
  };
}

export function listEpisodeWorkflows() { return listEpisodes().map((episode) => getEpisodeWorkflow(episode.id)); }
