import { getActiveTranscriptRevision, getEpisode, listEpisodes } from './episodes.ts';
import { listCandidates, validateApprovedCandidateBatch } from './candidates.ts';
import { listEpisodePipelineRequests } from './pipeline-requests.ts';
import { buildPublicationPackage } from './publication-package.ts';
import { getLatestWebsiteValidation } from './website-validation.ts';
import { getLatestGitPublication } from './git-publication.ts';
import { getLatestGitDeployment } from './git-deployment.ts';
import { getPublicationPreparation } from './thumbnails.ts';
import { listRegenerationProposals } from './regeneration-proposals.ts';

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

export type WorkDimension = { state: string; outstandingCount: number; reasons: string[]; ready: boolean };
export type EpisodeWorkProjection = {
  episodeId: string; episodeNumber: number | null; title: string; updatedAt: number;
  source: WorkDimension; snacks: WorkDimension & { available: boolean; finalSetApproved: boolean };
  assets: WorkDimension; publication: WorkDimension & { eligible: boolean; deployed: boolean };
  recommendedAction: { label: string; route: 'overview' | 'snacks' | 'assets' | 'publication' } | null;
};

export function deriveEpisodeWorkProjection(input: {
  hasTranscript: boolean; generationStatus: string | null; candidateCount: number; candidateDecisionCount: number; proposalCount: number;
  finalSetReady: boolean; finalSetApproved: boolean; assetReviewCount: number; assetReasons: string[];
  publicationActive: boolean; packageReady: boolean; blockers: Array<{ message: string }>;
  validationCurrent: boolean; publicationCurrent: boolean; deploymentCurrent: boolean;
}) {
  const sourceReasons = !input.hasTranscript ? ['Upload the episode transcript.']
    : input.generationStatus && FAILED.has(input.generationStatus) && !input.finalSetApproved ? ['Snack generation needs another attempt.'] : [];
  const generationActive = Boolean(input.generationStatus && ACTIVE.has(input.generationStatus));
  const snackReasons = [
    ...(input.candidateDecisionCount ? [`${input.candidateDecisionCount} Snack${input.candidateDecisionCount === 1 ? ' needs' : 's need'} an editorial decision.`] : []),
    ...(input.proposalCount ? [`${input.proposalCount} regeneration proposal${input.proposalCount === 1 ? ' needs' : 's need'} a decision.`] : []),
    ...(!input.finalSetApproved && input.finalSetReady ? ['Approve the final Snack set.'] : []),
  ];
  if (!input.finalSetApproved && !input.finalSetReady && !input.candidateDecisionCount && input.hasTranscript && !generationActive) snackReasons.push('Build the final Snack set.');
  const publicationReasons = input.finalSetApproved && !input.deploymentCurrent
    ? input.blockers.map((item) => item.message) : [];
  const source = { state: !input.hasTranscript ? 'needs-transcript' : generationActive ? 'generating' : sourceReasons.length ? 'needs-attention' : 'ready', outstandingCount: sourceReasons.length, reasons: sourceReasons, ready: input.hasTranscript && !sourceReasons.length };
  const snackOutstandingCount = input.candidateDecisionCount + input.proposalCount + (!input.finalSetApproved && input.finalSetReady ? 1 : 0) + (!input.finalSetApproved && !input.finalSetReady && !input.candidateDecisionCount && input.hasTranscript && !generationActive ? 1 : 0);
  const snacks = { state: generationActive ? 'generating' : snackReasons.length ? 'needs-review' : input.finalSetApproved ? 'approved' : 'ready', outstandingCount: snackOutstandingCount, reasons: snackReasons, ready: input.finalSetApproved, available: input.candidateCount > 0, finalSetApproved: input.finalSetApproved };
  const assets = { state: input.assetReviewCount ? 'needs-review' : input.finalSetApproved ? 'ready' : 'locked', outstandingCount: input.assetReviewCount, reasons: input.assetReasons, ready: input.finalSetApproved && !input.assetReviewCount };
  const publicationState = input.deploymentCurrent ? 'deployed' : input.publicationCurrent ? 'published-main' : input.validationCurrent ? 'validated' : input.packageReady ? 'ready-to-validate' : input.publicationActive ? 'preparing' : input.finalSetApproved ? 'blocked' : 'locked';
  const publication = { state: publicationState, outstandingCount: publicationReasons.length, reasons: publicationReasons, ready: input.deploymentCurrent, eligible: input.finalSetApproved, deployed: input.deploymentCurrent };
  const recommendedAction = !source.ready ? { label: source.state === 'needs-transcript' ? 'Upload transcript' : 'Review generation', route: 'overview' as const }
    : snacks.outstandingCount || !snacks.finalSetApproved ? { label: 'Review Snacks', route: 'snacks' as const }
    : assets.outstandingCount ? { label: 'Review assets', route: 'assets' as const }
    : !publication.deployed ? { label: publication.state === 'ready-to-validate' ? 'Validate publication' : publication.state === 'validated' ? 'Publish to main' : publication.state === 'published-main' ? 'Deploy website' : 'Complete publication', route: 'publication' as const }
    : null;
  return { source, snacks, assets, publication, recommendedAction };
}

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
  else if (input.assetReviewCount) { phase = 'asset-review'; status = `${input.assetReviewCount} item${input.assetReviewCount === 1 ? '' : 's'} to review`; action = { label: 'Review outstanding assets', route: 'assets' }; }
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
    try {
      const preparation = getPublicationPreparation(episodeId);
      assetReviewCount = preparation.jobs.filter((job) => job.status !== 'approved').length
        + preparation.participants.unresolved.length + preparation.contributorsNeedingPortraits.length;
    } catch {}
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

export function getEpisodeWorkProjection(episodeId: string): EpisodeWorkProjection {
  const episode = getEpisode(episodeId); if (!episode) throw new Error('Episode not found');
  const transcript = getActiveTranscriptRevision(episodeId); const candidates = listCandidates(episodeId);
  const approved = validateApprovedCandidateBatch(episodeId); const requests = listEpisodePipelineRequests(episodeId);
  const generation = requests.find((item) => item.operation === 'transcript-to-snacks') || null;
  const publicationActive = requests.some((item) => item.operation === 'publication-metadata' && ACTIVE.has(item.status));
  const finalSetApproved = ['approved','published'].includes(episode.status);
  const candidateDecisionCount = candidates.filter((item) => ['generated','in-review'].includes(item.reviewDecision)).length;
  const proposalCount = candidates.reduce((count, item) => count + listRegenerationProposals(item.id).filter((proposal) => proposal.status === 'proposed').length, 0);
  let assetReviewCount = 0; const assetReasons: string[] = []; let packageValue: ReturnType<typeof buildPublicationPackage> | null = null;
  if (finalSetApproved) {
    packageValue = buildPublicationPackage(episodeId);
    try {
      const preparation = getPublicationPreparation(episodeId);
      const unfinishedJobs = preparation.jobs.filter((job) => job.status !== 'approved').length;
      assetReviewCount = unfinishedJobs + preparation.participants.unresolved.length + preparation.contributorsNeedingPortraits.length;
      if (preparation.participants.unresolved.length) assetReasons.push(`${preparation.participants.unresolved.length} contributor profile${preparation.participants.unresolved.length === 1 ? '' : 's'} need resolution.`);
      if (preparation.contributorsNeedingPortraits.length) assetReasons.push(`${preparation.contributorsNeedingPortraits.length} contributor portrait${preparation.contributorsNeedingPortraits.length === 1 ? '' : 's'} need approval.`);
      if (unfinishedJobs) assetReasons.push(`${unfinishedJobs} thumbnail${unfinishedJobs === 1 ? '' : 's'} need generation or approval.`);
    } catch (error) { assetReviewCount = 1; assetReasons.push(error instanceof Error ? error.message : String(error)); }
  }
  const validation = getLatestWebsiteValidation(episodeId); const publicationAttempt = getLatestGitPublication(episodeId); const deployment = getLatestGitDeployment(episodeId);
  const fingerprint = packageValue?.fingerprint || null;
  const validationCurrent = Boolean(fingerprint && validation?.status === 'passed' && validation.packageFingerprint === fingerprint);
  const publicationCurrent = Boolean(validationCurrent && publicationAttempt?.status === 'published' && publicationAttempt.mainPushed && publicationAttempt.packageFingerprint === fingerprint);
  const deploymentCurrent = Boolean(publicationCurrent && deployment?.status === 'deployed' && deployment.deployedPushed && deployment.publicationAttemptId === publicationAttempt?.id);
  return { episodeId, episodeNumber: episode.episodeNumber, title: episode.publicTitle || episode.workingTitle, updatedAt: episode.updatedAt,
    ...deriveEpisodeWorkProjection({ hasTranscript: Boolean(transcript), generationStatus: generation?.status || null, candidateCount: candidates.length, candidateDecisionCount, proposalCount,
      finalSetReady: approved.ready, finalSetApproved, assetReviewCount, assetReasons, publicationActive, packageReady: Boolean(packageValue?.ready),
      blockers: packageValue?.blockers || [], validationCurrent, publicationCurrent, deploymentCurrent }) };
}

export function listEpisodeWorkProjections() { return listEpisodes().map((episode) => getEpisodeWorkProjection(episode.id)); }

export type WorkQueueKind = 'snacks' | 'assets' | 'publications';
export function selectWorkQueue(items: EpisodeWorkProjection[], kind: WorkQueueKind) {
  return items.filter((item) => kind === 'snacks' ? item.snacks.available : kind === 'assets' ? item.assets.outstandingCount > 0 : item.publication.eligible && !item.publication.deployed);
}
export function listWorkQueue(kind: WorkQueueKind) { return selectWorkQueue(listEpisodeWorkProjections(), kind); }

export function listEpisodeWorkflows() { return listEpisodes().map((episode) => getEpisodeWorkflow(episode.id)); }
