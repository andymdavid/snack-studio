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
import { getEpisodeGraphReadiness, listKnowledgeGraph } from './knowledge-graph.ts';
import { listTranscriptTopicIndex } from './discussion-topics.ts';

function optionalProjection<T>(read: () => T): { value: T | null; error: string | null } {
  try {
    return { value: read(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function publicationPackageForWorkspace(packageValue: ReturnType<typeof buildPublicationPackage> | null) {
  if (!packageValue?.transcript) return packageValue;
  const { transcriptText: _transcriptText, ...transcript } = packageValue.transcript;
  return { ...packageValue, transcript };
}

function websiteValidationForWorkspace(validation: ReturnType<typeof getLatestWebsiteValidation>) {
  if (!validation) return null;
  const { textDiff, buildOutput, ...summary } = validation;
  return {
    ...summary,
    textDiff: null,
    buildOutput: null,
    detailsAvailable: Boolean(textDiff || buildOutput),
    detailsLoaded: false,
  };
}

function transcriptForWorkspace(transcript: ReturnType<typeof getActiveTranscriptRevision>, includeText: boolean) {
  if (!transcript || includeText) return transcript;
  const { transcriptText: _transcriptText, ...metadata } = transcript;
  return metadata;
}

export type EpisodeWorkspaceView = 'overview' | 'snacks' | 'graph' | 'assets' | 'publication';

export function buildEpisodeWorkspace(episodeId: string, options: { view?: EpisodeWorkspaceView } = {}) {
  const episode = getEpisode(episodeId);
  if (!episode) return null;

  const view = options.view || 'overview';
  const includeOverview = view === 'overview';
  const includeAssets = view === 'assets' || view === 'publication';
  const includePublication = view === 'publication';
  const includeGraph = view === 'graph';

  markStalePipelineRunsTimedOut({ episodeId, timeoutMs: PIPELINE_TIMEOUT_MS });
  const pipelineRequests = listEpisodePipelineRequests(episodeId).map((request) => ({
    ...request,
    staleInput: request.inputTranscriptRevisionId !== episode.activeTranscriptRevisionId,
  }));
  const candidates = listCandidates(episodeId);
  // Work-queue state needs these projections for approved episodes even when
  // the current tab does not render their full payload.
  const preparation = optionalProjection(() => getPublicationPreparation(episodeId));
  const publicationPackage = optionalProjection(() => buildPublicationPackage(episodeId));

  return {
    episode,
    transcript: transcriptForWorkspace(getActiveTranscriptRevision(episodeId), includeOverview),
    publicTranscript: includePublication ? getLatestPublicTranscript(episodeId) : null,
    transcriptRevisions: listTranscriptRevisions(episodeId),
    auditEvents: includeOverview ? listEpisodeAuditEvents(episodeId) : [],
    candidates,
    generations: buildCandidateGenerations(candidates, pipelineRequests),
    approvedBatch: validateApprovedCandidateBatch(episodeId),
    regenerationProposals: Object.fromEntries(candidates.map((candidate) => [candidate.id, listRegenerationProposals(candidate.id)])),
    curation: getCuration(episodeId),
    graph: includeGraph ? (() => {
      const readiness = getEpisodeGraphReadiness(episodeId); const knowledge = listKnowledgeGraph(episodeId); const topicIndex = listTranscriptTopicIndex();
      return { readiness, knowledge, topicIndex: { topics: topicIndex.topics, analyses: topicIndex.analyses.filter((item) => item.episodeId === episodeId), passages: topicIndex.passages.filter((item) => item.episodeId === episodeId) } };
    })() : null,
    pipelineRequests,
    pipelineTimeoutMs: PIPELINE_TIMEOUT_MS,
    publicationPreparation: includeAssets ? preparation.value : null,
    publicationPreparationError: includeAssets ? preparation.error : null,
    publicationPackage: includePublication ? publicationPackageForWorkspace(publicationPackage.value) : null,
    websiteValidation: includePublication ? websiteValidationForWorkspace(getLatestWebsiteValidation(episodeId)) : null,
    gitPublication: includePublication ? getLatestGitPublication(episodeId) : null,
    gitDeployment: includePublication ? getLatestGitDeployment(episodeId) : null,
    work: getEpisodeWorkProjection(episodeId, {
      publicationPackage: publicationPackage.value,
      publicationPreparation: preparation.value,
    }),
  };
}
