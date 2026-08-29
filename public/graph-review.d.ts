export type GraphReviewFilters = { episodeId?: string; reviewState?: string; relationshipType?: string; query?: string };
export type GraphReviewPayload = { candidates?: Array<Record<string, unknown>>; relationships?: Array<Record<string, unknown>> };
export function deriveGraphReview(payload?: GraphReviewPayload, filters?: GraphReviewFilters): {
  filters: Required<GraphReviewFilters>;
  total: number;
  reviewed: number;
  drafts: number;
  visibleCount: number;
  groups: Array<{ source: Record<string, unknown>; relationships: Array<Record<string, unknown>> }>;
  episodes: Array<{ id: unknown; number: unknown; title: unknown }>;
};
