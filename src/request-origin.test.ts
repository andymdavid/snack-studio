import { describe, expect, test } from "bun:test";
import { publicRequestOrigin } from "./request-origin.ts";

describe("public request origin", () => {
  test("promotes a proxied public WApp host to HTTPS", () => {
    const req = new Request("http://able-dew-quay.lara.runwingman.com/api/episodes");
    expect(publicRequestOrigin(req)).toBe("https://able-dew-quay.lara.runwingman.com");
  });

  test("preserves loopback HTTP for local development", () => {
    const req = new Request("http://localhost:42009/api/episodes");
    expect(publicRequestOrigin(req)).toBe("http://localhost:42009");
  });

  test("honours the reverse proxy protocol", () => {
    const req = new Request("http://studio.example/api/episodes", { headers: { "x-forwarded-proto": "https" } });
    expect(publicRequestOrigin(req)).toBe("https://studio.example");
  });
});
