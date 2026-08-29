export type GraphReviewFilters = { episodeId?: string; reviewState?: string; relationshipType?: string; query?: string };
export type GraphReviewPayload = { candidates?: Array<Record<string, unknown>>; contributors?: Array<Record<string, unknown>>; relationships?: Array<Record<string, unknown>> };
export function deriveGraphReview(payload?: GraphReviewPayload, filters?: GraphReviewFilters): {
  filters: Required<GraphReviewFilters>;
  total: number;
  reviewed: number;
  drafts: number;
  visibleCount: number;
  groups: Array<{ source: Record<string, unknown>; relationships: Array<Record<string, unknown>> }>;
  episodes: Array<{ id: unknown; number: unknown; title: unknown }>;
};
export function deriveGraphFocus(payload?: GraphReviewPayload, candidateId?: string, options?: { includeDrafts?: boolean }): {
  focus: Record<string, unknown> | null;
  connections: Array<{ relationship: Record<string, unknown>; direction: 'incoming' | 'outgoing'; neighbour: Record<string, unknown> }>;
  approvedCount: number;
  draftCount: number;
  candidates: Array<Record<string, unknown>>;
};
export function deriveKnowledgeFocus(payload?: GraphReviewPayload & { knowledge?: { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>>; snackLinks?: Array<Record<string, unknown>> } }, requestedId?: string): {
  focus: (Record<string, unknown> & { id: string; kind: string; title: string }) | null;
  explicitFocus: boolean;
  connections: Array<{ id: string; relationshipType: string; direction: 'incoming' | 'outgoing'; neighbour: Record<string, unknown>; editable: boolean }>;
  allConnections: Array<{ id: string; sourceId: string; targetId: string; relationshipType: string }>;
  nodes: Array<Record<string, unknown> & { kind: string }>;
  totals: { nodes: number; knowledge: number; connections: number };
};
