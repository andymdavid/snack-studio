import { db } from "./db.ts";
import { getCandidate, listCandidates } from "./candidates.ts";
import { getEpisode, recordAuditEvent } from "./episodes.ts";

export const RELATIONSHIP_TYPES = ["overlaps", "develops", "contradicts", "revises", "exemplifies", "enables", "caused-by"] as const;
export type RelationshipType = typeof RELATIONSHIP_TYPES[number];
export type RelationshipState = "draft" | "approved" | "rejected";

export type NewsletterItem = { candidateId: string; position: number; title: string; reviewDecision: string };
export type Relationship = {
  id: string; episodeId: string; sourceCandidateId: string; targetCandidateId: string;
  sourceTitle: string; targetTitle: string; relationshipType: RelationshipType;
  explanation: string | null; origin: "manual" | "fixture" | "pipeline";
  reviewState: RelationshipState; createdAt: number; updatedAt: number;
};

function ensureNewsletter(episodeId: string) {
  const existing = db.query("SELECT * FROM newsletter_drafts WHERE episode_id = ?1").get(episodeId) as Record<string, unknown> | null;
  if (existing) return existing;
  const now = Date.now();
  const id = crypto.randomUUID();
  db.query("INSERT INTO newsletter_drafts(id, episode_id, status, created_at, updated_at) VALUES (?1, ?2, 'draft', ?3, ?3)")
    .run(id, episodeId, now);
  return db.query("SELECT * FROM newsletter_drafts WHERE id = ?1").get(id) as Record<string, unknown>;
}

export function listNewsletterItems(episodeId: string): NewsletterItem[] {
  const draft = ensureNewsletter(episodeId);
  const rows = db.query(`
    SELECT ni.candidate_id, ni.position, sc.review_decision, sr.public_title
    FROM newsletter_items ni
    JOIN snack_candidates sc ON sc.id = ni.candidate_id
    JOIN snack_revisions sr ON sr.id = sc.current_revision_id
    WHERE ni.newsletter_id = ?1 ORDER BY ni.position ASC
  `).all(String(draft.id)) as Record<string, unknown>[];
  return rows.map((row) => ({ candidateId: String(row.candidate_id), position: Number(row.position), title: String(row.public_title), reviewDecision: String(row.review_decision) }));
}

export function setNewsletterItems(episodeId: string, candidateIds: string[], actorPubkey: string): NewsletterItem[] {
  const draft = ensureNewsletter(episodeId);
  const uniqueIds = [...new Set(candidateIds)];
  if (uniqueIds.length > 4) throw new Error("Select no more than four newsletter snacks");
  for (const id of uniqueIds) {
    const candidate = getCandidate(id);
    if (!candidate || candidate.episodeId !== episodeId) throw new Error("Newsletter candidate does not belong to this episode");
    if (candidate.reviewDecision !== "accepted") throw new Error("Only accepted candidates can enter the newsletter");
  }
  const now = Date.now();
  db.transaction(() => {
    db.query("DELETE FROM newsletter_items WHERE newsletter_id = ?1").run(String(draft.id));
    uniqueIds.forEach((candidateId, index) => db.query(
      "INSERT INTO newsletter_items(newsletter_id, candidate_id, position, created_at) VALUES (?1, ?2, ?3, ?4)",
    ).run(String(draft.id), candidateId, index + 1, now));
    db.query("UPDATE newsletter_drafts SET updated_at = ?1 WHERE id = ?2").run(now, String(draft.id));
    recordAuditEvent({ actorPubkey, action: "newsletter.selection.updated", entityType: "episode", entityId: episodeId, detail: { candidateIds: uniqueIds } });
  })();
  return listNewsletterItems(episodeId);
}

function mapRelationship(row: Record<string, unknown>): Relationship {
  return {
    id: String(row.id), episodeId: String(row.episode_id), sourceCandidateId: String(row.source_candidate_id),
    targetCandidateId: String(row.target_candidate_id), sourceTitle: String(row.source_title), targetTitle: String(row.target_title),
    relationshipType: String(row.relationship_type) as RelationshipType,
    explanation: row.explanation == null ? null : String(row.explanation), origin: String(row.origin) as Relationship["origin"],
    reviewState: String(row.review_state) as RelationshipState, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export function listRelationships(episodeId: string): Relationship[] {
  const rows = db.query(`
    SELECT rel.*, source_revision.public_title AS source_title, target_revision.public_title AS target_title
    FROM relationships rel
    JOIN snack_candidates source ON source.id = rel.source_candidate_id
    JOIN snack_revisions source_revision ON source_revision.id = source.current_revision_id
    JOIN snack_candidates target ON target.id = rel.target_candidate_id
    JOIN snack_revisions target_revision ON target_revision.id = target.current_revision_id
    WHERE rel.episode_id = ?1 ORDER BY rel.created_at ASC
  `).all(episodeId) as Record<string, unknown>[];
  return rows.map(mapRelationship);
}

export function createRelationship(input: {
  episodeId: string; sourceCandidateId: string; targetCandidateId: string; relationshipType: RelationshipType;
  explanation: string | null; origin: "manual" | "fixture" | "pipeline"; reviewState: RelationshipState; actorPubkey: string;
}): Relationship {
  if (input.sourceCandidateId === input.targetCandidateId) throw new Error("A snack cannot relate to itself");
  for (const id of [input.sourceCandidateId, input.targetCandidateId]) {
    const candidate = getCandidate(id);
    if (!candidate || candidate.episodeId !== input.episodeId) throw new Error("Relationship candidates must belong to this episode");
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.query(`INSERT INTO relationships(
      id, episode_id, source_candidate_id, target_candidate_id, relationship_type,
      explanation, origin, review_state, created_by_pubkey, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
      .run(id, input.episodeId, input.sourceCandidateId, input.targetCandidateId, input.relationshipType,
        input.explanation, input.origin, input.reviewState, input.actorPubkey, now);
    recordAuditEvent({ actorPubkey: input.actorPubkey, action: "relationship.created", entityType: "episode", entityId: input.episodeId, detail: { relationshipId: id, type: input.relationshipType, origin: input.origin } });
  })();
  return listRelationships(input.episodeId).find((item) => item.id === id)!;
}

export function updateRelationshipState(id: string, state: RelationshipState, actorPubkey: string): Relationship | null {
  const row = db.query("SELECT episode_id FROM relationships WHERE id = ?1").get(id) as { episode_id: string } | null;
  if (!row) return null;
  const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE relationships SET review_state = ?1, updated_at = ?2 WHERE id = ?3").run(state, now, id);
    recordAuditEvent({ actorPubkey, action: "relationship.review.updated", entityType: "episode", entityId: row.episode_id, detail: { relationshipId: id, state } });
  })();
  return listRelationships(row.episode_id).find((item) => item.id === id)!;
}

export function deleteRelationship(id: string, actorPubkey: string): boolean {
  const row = db.query("SELECT episode_id FROM relationships WHERE id = ?1").get(id) as { episode_id: string } | null;
  if (!row) return false;
  db.transaction(() => {
    db.query("DELETE FROM relationships WHERE id = ?1").run(id);
    recordAuditEvent({ actorPubkey, action: "relationship.deleted", entityType: "episode", entityId: row.episode_id, detail: { relationshipId: id } });
  })();
  return true;
}

export function createFixtureRelationshipSuggestions(episodeId: string, actorPubkey: string): Relationship[] {
  if (listRelationships(episodeId).length) throw new Error("relationship set already exists");
  const candidates = listCandidates(episodeId).filter((candidate) => candidate.reviewDecision !== "rejected");
  if (candidates.length < 3) throw new Error("At least three candidates are required");
  createRelationship({ episodeId, sourceCandidateId: candidates[0]!.id, targetCandidateId: candidates[1]!.id, relationshipType: "develops", explanation: "The second idea extends the operational implications of the first.", origin: "fixture", reviewState: "draft", actorPubkey });
  createRelationship({ episodeId, sourceCandidateId: candidates[1]!.id, targetCandidateId: candidates[2]!.id, relationshipType: "enables", explanation: "The source idea creates conditions that make the target idea practical.", origin: "fixture", reviewState: "draft", actorPubkey });
  return listRelationships(episodeId);
}

export function validateEpisodePackage(episodeId: string) {
  const episode = getEpisode(episodeId);
  if (!episode) throw new Error("episode not found");
  const candidates = listCandidates(episodeId);
  const accepted = candidates.filter((candidate) => candidate.reviewDecision === "accepted");
  const undecided = candidates.filter((candidate) => ["generated", "in-review", "regeneration-requested"].includes(candidate.reviewDecision));
  const newsletter = listNewsletterItems(episodeId);
  const relationships = listRelationships(episodeId);
  const approvedRelationships = relationships.filter((relationship) => relationship.reviewState === "approved");
  const checks = [
    { key: "metadata", ok: Boolean(episode.workingTitle && episode.episodeNumber), message: "Episode number and working title are present" },
    { key: "transcript", ok: Boolean(episode.activeTranscriptRevisionId), message: "An active transcript revision is selected" },
    { key: "accepted", ok: accepted.length > 0, message: `${accepted.length} accepted snack${accepted.length === 1 ? "" : "s"}` },
    { key: "review", ok: undecided.length === 0, message: `${undecided.length} candidate${undecided.length === 1 ? "" : "s"} still need decisions` },
    { key: "newsletter", ok: newsletter.length >= 3 && newsletter.length <= 4 && newsletter.every((item) => item.reviewDecision === "accepted"), message: `${newsletter.length} newsletter snack${newsletter.length === 1 ? "" : "s"} selected${newsletter.some((item) => item.reviewDecision !== "accepted") ? "; remove non-accepted items" : ""}` },
    { key: "relationships", ok: approvedRelationships.length > 0, message: `${approvedRelationships.length} approved relationship${approvedRelationships.length === 1 ? "" : "s"}` },
  ];
  return { ready: checks.every((check) => check.ok), checks, counts: { candidates: candidates.length, accepted: accepted.length, newsletter: newsletter.length, relationships: relationships.length, approvedRelationships: approvedRelationships.length } };
}

export function getCuration(episodeId: string) {
  return { newsletterItems: listNewsletterItems(episodeId), relationships: listRelationships(episodeId), validation: validateEpisodePackage(episodeId) };
}
