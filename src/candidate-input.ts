import type { CandidateRevisionInput } from "./candidates.ts";

const REVIEW_DECISIONS = ["generated", "in-review", "accepted", "rejected", "regeneration-requested"] as const;
type ReviewDecision = typeof REVIEW_DECISIONS[number];

export function validateReviewDecision(value: unknown): ReviewDecision | null {
  return typeof value === "string" && REVIEW_DECISIONS.includes(value as ReviewDecision) ? value as ReviewDecision : null;
}

export function validateCandidateRevision(body: Record<string, unknown>):
  | { ok: true; value: CandidateRevisionInput }
  | { ok: false; error: string } {
  const required = (key: string, max: number) => typeof body[key] === "string" && String(body[key]).trim().length <= max
    ? String(body[key]).trim()
    : "";
  const optional = (key: string, max: number) => {
    if (body[key] == null || body[key] === "") return null;
    const value = typeof body[key] === "string" ? String(body[key]).trim() : "";
    return value && value.length <= max ? value : null;
  };
  const publicTitle = required("publicTitle", 200);
  const standfirst = required("standfirst", 500);
  const bodyMarkdown = required("bodyMarkdown", 100_000);
  if (!publicTitle) return { ok: false, error: "publicTitle is required and must be 200 characters or fewer" };
  if (!standfirst) return { ok: false, error: "standfirst is required and must be 500 characters or fewer" };
  if (!bodyMarkdown) return { ok: false, error: "bodyMarkdown is required" };
  const relatedTopics = Array.isArray(body.relatedTopics)
    ? body.relatedTopics.map(String)
    : typeof body.relatedTopics === "string"
      ? body.relatedTopics.split(",")
      : [];
  const normalizedRelatedTopics = [...new Set(relatedTopics.map((topic) => topic.trim()).filter(Boolean))].slice(0, 20);
  return {
    ok: true,
    value: {
      publicTitle,
      editorialTitle: optional("editorialTitle", 200),
      standfirst,
      bodyMarkdown,
      attribution: optional("attribution", 300),
      primaryTopic: optional("primaryTopic", 100),
      relatedTopics: normalizedRelatedTopics,
      transcriptTimestamp: optional("transcriptTimestamp", 30),
      transcriptExcerpt: optional("transcriptExcerpt", 2_000),
      seoTitle: optional("seoTitle", 200),
      seoDescription: optional("seoDescription", 500),
      changeNote: optional("changeNote", 500),
    },
  };
}
