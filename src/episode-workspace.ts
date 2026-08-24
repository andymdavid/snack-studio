import { buildCandidateGenerations } from './candidate-generations.ts';
import { listCandidates, validateApprovedCandidateBatch } from './candidates.ts';
import { getCuration } from './curation.ts';
import { getEpisodeWorkProjection } from './episode-workflow.ts';
import { getActiveTranscriptRevision, getEpisode, listEpisodeAuditEvents, listTranscriptRevisions } from './episodes.ts';
import { getLatestGitDeployment } from './git-deployment.ts';
import { getLatestGitPublication } from './git-publication.ts';
import { PIPELINE_TIMEOUT_MS } from './config.ts';
import { listEpisodePipelineRequests, markStalePipelineRunsTimedOut } from './pipeline-requests.ts';
import { buildPublicationPackage } from './publication-package.ts';
import { getLatestPublicTranscript } from './public-transcripts.ts';
import { listRegenerationProposals } from './regeneration-proposals.ts';
import { getPublicationPreparation } from './thumbnails.ts';
import { getLatestWebsiteValidation } from './website-validation.ts';

function optionalProjection<T>(read: () => T): { value: T | null; error: string | null } {
  try {
    return { value: read(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildEpisodeWorkspace(episodeId: string) {
  const episode = getEpisode(episodeId);
  if (!episode) return null;

  markStalePipelineRunsTimedOut({ episodeId, timeoutMs: PIPELINE_TIMEOUT_MS });
  const pipelineRequests = listEpisodePipelineRequests(episodeId).map((request) => ({
    ...request,
    staleInput: request.inputTranscriptRevisionId !== episode.activeTranscriptRevisionId,
  }));
  const candidates = listCandidates(episodeId);
  const preparation = optionalProjection(() => getPublicationPreparation(episodeId));
  const publicationPackage = optionalProjection(() => buildPublicationPackage(episodeId));

  return {
    episode,
    transcript: getActiveTranscriptRevision(episodeId),
    publicTranscript: getLatestPublicTranscript(episodeId),
    transcriptRevisions: listTranscriptRevisions(episodeId),
    auditEvents: listEpisodeAuditEvents(episodeId),
    candidates,
    generations: buildCandidateGenerations(candidates, pipelineRequests),
    approvedBatch: validateApprovedCandidateBatch(episodeId),
    regenerationProposals: Object.fromEntries(candidates.map((candidate) => [candidate.id, listRegenerationProposals(candidate.id)])),
    curation: getCuration(episodeId),
    pipelineRequests,
    pipelineTimeoutMs: PIPELINE_TIMEOUT_MS,
    publicationPreparation: preparation.value,
    publicationPreparationError: preparation.error,
    publicationPackage: publicationPackage.value,
    websiteValidation: getLatestWebsiteValidation(episodeId),
    gitPublication: getLatestGitPublication(episodeId),
    gitDeployment: getLatestGitDeployment(episodeId),
    work: getEpisodeWorkProjection(episodeId),
  };
}
