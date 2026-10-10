import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockProtect, fixtures, type MockProtect } from "@unifi-mcp/mock-protect";
import {
  SlidingWindowLimiter,
  UnifiClient,
  UnifiError,
  appUrl,
  errorFromStatus,
  listConsoles,
  parseRetryAfter,
  pickConsole,
  unwrapList,
} from "../src/index.js";

const KEY = "test-key";

describe("routing", () => {
  it("builds local Integration API URLs", () => {
    expect(appUrl({ mode: "local", host: "192.168.1.1" }, "protect", "/v1/cameras")).toBe(
      "https://192.168.1.1/proxy/protect/integration/v1/cameras",
    );
    expect(appUrl({ mode: "local", host: "https://udm.lan:8443/" }, "network", "/v1/sites")).toBe(
      "https://udm.lan:8443/proxy/network/integration/v1/sites",
    );
  });

  it("builds cloud connector URLs with the console id and query", () => {
    const id = fixtures.CONSOLE_ID_HOME;
    expect(appUrl({ mode: "cloud", consoleId: id }, "protect", "/v1/cameras/abc/snapshot", { highQuality: true, channel: undefined })).toBe(
      `https://api.ui.com/v1/connector/consoles/${id}/proxy/protect/integration/v1/cameras/abc/snapshot?highQuality=true`,
    );
  });

  it("rejects path-unsafe console ids and hosts", () => {
    expect(() => appUrl({ mode: "cloud", consoleId: "../../v1/hosts" }, "protect", "/v1/cameras")).toThrow(UnifiError);
    expect(() => appUrl({ mode: "local", host: "evil.com/x?" }, "protect", "/v1/cameras")).toThrow(UnifiError);
    expect(() => appUrl({ mode: "cloud" }, "protect", "/v1/cameras")).toThrow(/No console selected/);
  });
});

describe("errors", () => {
  it("maps statuses to friendly kinds", () => {
    expect(errorFromStatus(401, { mode: "cloud" }).kind).toBe("auth");
    expect(errorFromStatus(401, { mode: "cloud" }).toUserMessage()).toMatch(/Site Manager API key/);
    expect(errorFromStatus(403, { mode: "local" }).toUserMessage()).toMatch(/Control Plane → Integrations/);
    expect(errorFromStatus(404, { mode: "local", what: "camera x" }).toUserMessage()).toMatch(/newer than your Protect version/);
    expect(errorFromStatus(502, { mode: "cloud" }).toUserMessage()).toMatch(/Remote Access/);
    expect(errorFromStatus(429, { mode: "cloud", retryAfterSeconds: 7 }).toUserMessage()).toMatch(/7s/);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter("5.37")).toBe(6);
    const now = Date.parse("2026-10-09T00:00:00Z");
    expect(parseRetryAfter("Fri, 09 Oct 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("limiter", () => {
  it("allows N per window then reports the wait", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect(l.take("a")).toBe(0);
    expect(l.take("a")).toBe(0);
    expect(l.take("a")).toBe(1000);
    expect(l.take("b")).toBe(0);
    t = 1001;
    expect(l.take("a")).toBe(0);
  });
});

describe("unwrapList", () => {
  it("accepts arrays and data envelopes", () => {
    expect(unwrapList([1, 2])).toEqual([1, 2]);
    expect(unwrapList({ data: [3] })).toEqual([3]);
    expect(unwrapList({})).toEqual([]);
  });
});

describe("UnifiClient against the mock", () => {
  let mock: MockProtect;
  beforeEach(async () => {
    mock = await startMockProtect({ apiKey: KEY });
  });
  afterEach(async () => {
    await mock.close();
  });

  it("refuses to start without a key", () => {
    expect(() => new UnifiClient({ apiKey: " ", mode: "local", host: "x" })).toThrow(/No UniFi API key/);
  });

  it("calls the local path with X-API-KEY", async () => {
    const c = new UnifiClient({ apiKey: KEY, mode: "local", host: mock.url });
    const cams = unwrapList(await c.getJson("protect", "/v1/cameras"));
    expect(cams).toHaveLength(4);
    expect(mock.requests[0]).toMatchObject({ url: "/proxy/protect/integration/v1/cameras", apiKey: KEY });
  });

  it("calls the cloud connector path", async () => {
    const c = new UnifiClient({ apiKey: KEY, mode: "cloud", consoleId: fixtures.CONSOLE_ID_HOME, cloudBaseUrl: mock.url });
    const info = await c.getJson<{ applicationVersion: string }>("protect", "/v1/meta/info");
    expect(info.applicationVersion).toBe("7.2.105");
    expect(mock.requests[0].url).toBe(`/v1/connector/consoles/${fixtures.CONSOLE_ID_HOME}/proxy/protect/integration/v1/meta/info`);
  });

  it("maps a bad key to an auth error that never echoes the key", async () => {
    const secret = "sk-super-secret-value";
    const c = new UnifiClient({ apiKey: secret, mode: "local", host: mock.url });
    const err = await c.getJson("protect", "/v1/cameras").catch((e) => e);
    expect(err).toBeInstanceOf(UnifiError);
    expect(err.kind).toBe("auth");
    expect(err.toUserMessage()).not.toContain(secret);
  });

  it("retries once on a short 429", async () => {
    mock.options.fail429 = 1;
    mock.options.retryAfterSeconds = 0;
    const c = new UnifiClient({ apiKey: KEY, mode: "local", host: mock.url });
    expect(unwrapList(await c.getJson("protect", "/v1/lights"))).toHaveLength(1);
    expect(mock.requests).toHaveLength(2);
  });

  it("surfaces long 429s with a retry hint", async () => {
    mock.options.fail429 = 5;
    mock.options.retryAfterSeconds = 30;
    const c = new UnifiClient({ apiKey: KEY, mode: "local", host: mock.url });
    const err = await c.getJson("protect", "/v1/lights").catch((e) => e);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("enforces the per-console cloud limit locally", async () => {
    const c = new UnifiClient({
      apiKey: KEY,
      mode: "cloud",
      consoleId: fixtures.CONSOLE_ID_HOME,
      cloudBaseUrl: mock.url,
      limiter: new SlidingWindowLimiter(2, 60_000),
    });
    await c.getJson("protect", "/v1/meta/info");
    await c.getJson("protect", "/v1/meta/info");
    const err = await c.getJson("protect", "/v1/meta/info").catch((e) => e);
    expect(err.kind).toBe("rate_limited");
    expect(mock.requests).toHaveLength(2);
  });

  it("reports an unreachable console in cloud mode", async () => {
    mock.options.consoleOffline = true;
    const c = new UnifiClient({ apiKey: KEY, mode: "cloud", consoleId: fixtures.CONSOLE_ID_HOME, cloudBaseUrl: mock.url });
    const err = await c.getJson("protect", "/v1/cameras").catch((e) => e);
    expect(err.kind).toBe("offline");
    expect(err.toUserMessage()).toMatch(/Remote Access/);
  });

  it("reports network failures without leaking details", async () => {
    const c = new UnifiClient({ apiKey: KEY, mode: "local", host: "http://127.0.0.1:1" });
    const err = await c.getJson("protect", "/v1/cameras").catch((e) => e);
    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/connection refused|network error/);
  });

  it("times out", async () => {
    const hang = () => new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("aborted")), 200));
    const c = new UnifiClient({ apiKey: KEY, mode: "local", host: mock.url, timeoutMs: 50, fetch: (_u, init) => {
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        void hang().catch(() => undefined);
      });
    } });
    const err = await c.getJson("protect", "/v1/cameras").catch((e) => e);
    expect(err.kind).toBe("timeout");
  });

  it("downloads binary snapshots", async () => {
    const c = new UnifiClient({ apiKey: KEY, mode: "local", host: mock.url });
    const img = await c.getBinary("protect", `/v1/cameras/${fixtures.CAMERA_FRONT}/snapshot`);
    expect(img.contentType).toBe("image/jpeg");
    expect(img.bytes[0]).toBe(0xff);
    expect(img.bytes[1]).toBe(0xd8);
  });

  it("lists and picks consoles", async () => {
    const c = new UnifiClient({ apiKey: KEY, mode: "cloud", cloudBaseUrl: mock.url });
    const one = await listConsoles(c);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ name: "Home UDM Pro", model: "UniFi Dream Machine Pro", protectVersion: "7.2.105" });
    expect(one[0].apps).toContain("protect");
    expect(pickConsole(one, "protect").id).toBe(fixtures.CONSOLE_ID_HOME);

    mock.options.hosts = "two";
    const two = await listConsoles(c);
    expect(() => pickConsole(two, "protect")).toThrow(/2 online consoles running protect/);

    mock.options.hosts = "none";
    expect(() => pickConsole([], "protect")).toThrow(/None of the 0 console/);
  });
});
