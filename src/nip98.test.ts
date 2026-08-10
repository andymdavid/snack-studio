import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { verifyNip98Request } from "./nip98.ts";

function authorization(input: { url: string; method: string; body?: string; createdAt?: number }) {
  const tags = [["u", input.url], ["method", input.method]];
  if (input.body !== undefined) tags.push(["payload", bytesToHex(sha256(new TextEncoder().encode(input.body)))]);
  const event = finalizeEvent({
    kind: 27235,
    created_at: input.createdAt ?? 2_000_000_000,
    tags,
    content: "",
  }, generateSecretKey());
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

describe("NIP-98 request verification", () => {
  const now = 2_000_000_000;
  const url = "https://studio.example/api/nip98/pipeline-requests/request-1/context";

  test("accepts an exact, recent signed request", async () => {
    const request = new Request(url, { headers: { authorization: authorization({ url, method: "GET" }) } });
    expect(await verifyNip98Request(request, new URL(url), now)).toMatchObject({ ok: true });
  });

  test("rejects URL, method, and timestamp mismatches", async () => {
    const wrongUrl = new Request(url, { headers: { authorization: authorization({ url: `${url}/wrong`, method: "GET" }) } });
    expect(await verifyNip98Request(wrongUrl, new URL(url), now)).toEqual({ ok: false, error: "NIP-98 URL mismatch" });

    const wrongMethod = new Request(url, { headers: { authorization: authorization({ url, method: "POST" }) } });
    expect(await verifyNip98Request(wrongMethod, new URL(url), now)).toEqual({ ok: false, error: "NIP-98 method mismatch" });

    const expired = new Request(url, { headers: { authorization: authorization({ url, method: "GET", createdAt: now - 301 }) } });
    expect(await verifyNip98Request(expired, new URL(url), now)).toEqual({ ok: false, error: "NIP-98 event expired" });
  });

  test("requires the exact payload hash for body-bearing methods", async () => {
    const body = JSON.stringify({ status: "running" });
    const valid = new Request(url, { method: "POST", body, headers: { authorization: authorization({ url, method: "POST", body }) } });
    expect(await verifyNip98Request(valid, new URL(url), now)).toMatchObject({ ok: true });

    const changed = new Request(url, { method: "POST", body: `${body} `, headers: { authorization: authorization({ url, method: "POST", body }) } });
    expect(await verifyNip98Request(changed, new URL(url), now)).toEqual({ ok: false, error: "NIP-98 payload mismatch" });
  });
});
