import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { nip19, verifyEvent, type Event } from "nostr-tools";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const NIP98_KIND = 27235;
const NIP98_MAX_AGE_SECONDS = 5 * 60;

function decodeNip98Token(raw: string | null): Event | null {
  if (!raw) return null;
  const [scheme, token] = raw.split(" ");
  if (scheme !== "Nostr" || !token) return null;
  try {
    return JSON.parse(atob(token)) as Event;
  } catch {
    return null;
  }
}

function sha256Hex(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function normaliseUrl(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export async function verifyNip98Request(
  req: Request,
  url: URL,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; pubkey: string; npub: string } | { ok: false; error: string }> {
  const event = decodeNip98Token(req.headers.get("authorization"));
  if (!event) return { ok: false, error: "NIP-98 authorization required" };
  if (event.kind !== NIP98_KIND) return { ok: false, error: "Invalid NIP-98 event kind" };
  if (!HEX_PUBKEY.test(event.pubkey)) return { ok: false, error: "Invalid NIP-98 pubkey" };
  if (!verifyEvent(event)) return { ok: false, error: "Invalid NIP-98 signature" };

  const eventUrl = event.tags.find((tag) => tag[0] === "u")?.[1];
  const eventMethod = event.tags.find((tag) => tag[0] === "method")?.[1];
  if (!eventUrl || normaliseUrl(eventUrl) !== url.toString()) return { ok: false, error: "NIP-98 URL mismatch" };
  if (!eventMethod || eventMethod.toUpperCase() !== req.method.toUpperCase()) return { ok: false, error: "NIP-98 method mismatch" };
  if (Math.abs(nowSeconds - Number(event.created_at)) > NIP98_MAX_AGE_SECONDS) return { ok: false, error: "NIP-98 event expired" };

  if (["POST", "PUT", "PATCH"].includes(req.method.toUpperCase())) {
    const payload = event.tags.find((tag) => tag[0] === "payload")?.[1];
    const expected = sha256Hex(await req.clone().text());
    if (!payload || payload !== expected) return { ok: false, error: "NIP-98 payload mismatch" };
  }

  return { ok: true, pubkey: event.pubkey, npub: nip19.npubEncode(event.pubkey) };
}
