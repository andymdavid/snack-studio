export const MAX_PASTED_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_TRANSCRIPT_UPLOAD_BYTES = 5 * 1024 * 1024;

export function validateTranscriptUpload(file: File): { ok: true } | { ok: false; error: string } {
  const filename = file.name.toLowerCase();
  if (!filename.endsWith(".txt")) return { ok: false, error: "Transcript uploads must be .txt files" };
  if (file.size < 1) return { ok: false, error: "The transcript file is empty" };
  if (file.size > MAX_TRANSCRIPT_UPLOAD_BYTES) return { ok: false, error: "Transcript uploads must be 5 MB or smaller" };
  const mediaType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType && !["text/plain", "application/octet-stream"].includes(mediaType)) {
    return { ok: false, error: "Transcript uploads must use a plain-text media type" };
  }
  return { ok: true };
}

export function normalizeTranscriptText(value: unknown):
  | { ok: true; text: string; sizeBytes: number }
  | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "transcriptText is required" };
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (!normalized) return { ok: false, error: "transcriptText is required" };
  const sizeBytes = new TextEncoder().encode(normalized).byteLength;
  if (sizeBytes > MAX_PASTED_TRANSCRIPT_BYTES) {
    return { ok: false, error: "Pasted transcripts must be 5 MB or smaller" };
  }
  return { ok: true, text: normalized, sizeBytes };
}

export function validateEpisodeMetadata(body: Record<string, unknown>):
  | { ok: true; value: { episodeNumber: number | null; workingTitle: string; publicTitle: string | null; publicSummary: string | null; primaryTopic: string | null; recordedOn: string | null; audioUrl: string | null; videoUrl: string | null; editorialNotes: string | null } }
  | { ok: false; error: string } {
  const workingTitle = typeof body.workingTitle === "string" ? body.workingTitle.trim() : "";
  if (!workingTitle) return { ok: false, error: "workingTitle is required" };
  if (workingTitle.length > 160) return { ok: false, error: "workingTitle must be 160 characters or fewer" };
  const rawEpisodeNumber = body.episodeNumber;
  const episodeNumber = rawEpisodeNumber === null || rawEpisodeNumber === undefined || rawEpisodeNumber === ""
    ? null
    : Number(rawEpisodeNumber);
  if (episodeNumber !== null && (!Number.isInteger(episodeNumber) || episodeNumber < 1)) {
    return { ok: false, error: "episodeNumber must be a positive whole number" };
  }

  const optionalText = (key: string, max: number): string | null | false => {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") return false;
    const value = raw.trim();
    return value.length <= max ? value || null : false;
  };
  const publicTitle = optionalText("publicTitle", 200);
  const publicSummary = optionalText('publicSummary', 500);
  const primaryTopic = optionalText('primaryTopic', 100);
  const recordedOn = optionalText("recordedOn", 10);
  const audioUrl = optionalText("audioUrl", 2000);
  const videoUrl = optionalText("videoUrl", 2000);
  const editorialNotes = optionalText("editorialNotes", 20_000);
  if ([publicTitle, publicSummary, primaryTopic, recordedOn, audioUrl, videoUrl, editorialNotes].includes(false)) {
    return { ok: false, error: "One or more metadata fields exceed their allowed length" };
  }
  if (recordedOn && !/^\d{4}-\d{2}-\d{2}$/.test(recordedOn)) {
    return { ok: false, error: "recordedOn must use YYYY-MM-DD" };
  }
  if (primaryTopic && !['ai-coding', 'agents', 'software-systems'].includes(primaryTopic)) {
    return { ok: false, error: 'primaryTopic must be a canonical website topic' };
  }
  for (const [label, value] of [["audioUrl", audioUrl], ["videoUrl", videoUrl]] as const) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return { ok: false, error: `${label} must be a valid http(s) URL` };
    }
  }
  return {
    ok: true,
    value: {
      workingTitle,
      episodeNumber,
      publicTitle: publicTitle as string | null,
      publicSummary: publicSummary as string | null,
      primaryTopic: primaryTopic as string | null,
      recordedOn: recordedOn as string | null,
      audioUrl: audioUrl as string | null,
      videoUrl: videoUrl as string | null,
      editorialNotes: editorialNotes as string | null,
    },
  };
}
