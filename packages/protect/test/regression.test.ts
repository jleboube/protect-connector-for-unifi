// Regressions found against a real 6-console account (Oct 2026), replayed with
// sanitized fixtures (fake IDs, names and MACs) that mirror the real shapes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockProtect, fixtures, type MockProtect } from "@unifi-mcp/mock-protect";
import { UnifiClient, listConsoles, pickConsole, matchConsole } from "@unifi-mcp/core";
import { connect, textOf } from "./helpers.js";
import { createHandler } from "../src/worker.js";

const KEY = "regression-key-456"; // gitleaks:allow (fake test key)
const { FLEET } = fixtures;
let mock: MockProtect;
beforeEach(async () => {
  mock = await startMockProtect({ apiKey: KEY, hosts: "fleet", forbiddenConsoles: [FLEET.udmSe] });
});
afterEach(async () => {
  await mock.close();
});
const cloud = () => new UnifiClient({ apiKey: KEY, mode: "cloud", cloudBaseUrl: mock.url });
const hitConsole = (id: string) => mock.requests.some((r) => r.url.startsWith(`/v1/connector/consoles/${id}/`));

describe("console discovery against real-world host shapes", () => {
  it("only counts installed apps (userData.controllers lists supported apps)", async () => {
    const consoles = await listConsoles(cloud());
    const byId = Object.fromEntries(consoles.map((c) => [c.id, c]));
    expect(byId[FLEET.express].apps).toEqual(["network"]);
    expect(byId[FLEET.nas].apps).toEqual(["drive"]);
    expect(byId[FLEET.udmPro].apps).toEqual(["network", "protect"]);
    expect(byId[FLEET.oldUdmPro]).toMatchObject({ connected: false, protectVersion: "2.10.10" });
  });

  it("ambiguity lists only online consoles with a usable Protect", async () => {
    const consoles = await listConsoles(cloud());
    let msg = "";
    try {
      pickConsole(consoles, "protect");
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toMatch(/2 online consoles running protect/);
    expect(msg).toContain(FLEET.udmPro);
    expect(msg).toContain(FLEET.udmSe);
    expect(msg).not.toContain(FLEET.oldUdmPro);
    expect(msg).not.toContain(FLEET.oldCloudKey);
    // Duplicate names narrow to the online Protect console.
    expect(matchConsole(consoles, "dream machine pro", "protect").id).toBe(FLEET.udmPro);
    expect(matchConsole(consoles, "Dream-Machine-Pro", "protect").id).toBe(FLEET.udmPro);
    expect(() => matchConsole(consoles, "nope", "protect")).toThrow(/No console named/);
  });

  it("unifi_list_consoles shows state, old Protect versions and a selection hint", async () => {
    const s = await connect(cloud());
    const out = textOf(await s.call("unifi_list_consoles"));
    expect(out).toContain("6 consoles:");
    expect(out).toMatch(/Express 7 — [^\n]*apps: network \[console_id/);
    expect(out).toContain("Protect 2.10.10 (too old for the API, needs 5.3+)");
    expect(out).toContain("OFFLINE");
    expect(out).toContain("[host Dream-Machine-Pro]");
    expect(out).toContain("2 online consoles run Protect; pass console_id");
    await s.close();
  });

  it("picks a console by name, and refuses an old-Protect console clearly", async () => {
    const s = await connect(cloud());
    const ok = await s.call("protect_list_cameras", { console_id: "Dream Machine Pro" });
    expect(ok.isError, textOf(ok)).toBeFalsy();
    expect(hitConsole(FLEET.udmPro)).toBe(true);
    const old = await s.call("protect_get_nvr", { console_id: "cloudkey+" });
    expect(old.isError).toBe(true);
    expect(textOf(old)).toMatch(/Protect 5\.0\.47, which predates/);
    expect(hitConsole(FLEET.oldCloudKey)).toBe(false);
    await s.close();
  });

  it("explains 403 'insufficient permissions for this host'", async () => {
    const s = await connect(cloud(), undefined, "Branch Dream Machine SE");
    const r = await s.call("protect_get_nvr");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/isn't allowed to reach that console.*insufficient permissions/);
    expect(textOf(r)).toMatch(/unifi_list_consoles/);
    expect(textOf(r)).not.toContain(KEY);
    await s.close();
  });
});

describe("camera data quirks", () => {
  it("trims padded names and reuses the listed camera (one upstream call)", async () => {
    const s = await connect(cloud(), undefined, FLEET.udmPro);
    const list = textOf(await s.call("protect_list_cameras"));
    expect(list).toContain("- Side Gate — online · UVC G3 Flex · no smart detection");
    mock.requests.length = 0;
    const cam = await s.call("protect_get_camera", { camera: "side gate" });
    expect(cam.isError, textOf(cam)).toBeFalsy();
    expect(textOf(cam)).toContain("Side Gate");
    expect(mock.requests.filter((r) => r.url.includes("/cameras"))).toHaveLength(1);
    await s.close();
  });
});

describe("Worker console header", () => {
  it("accepts a console name in X-UniFi-Console-Id", async () => {
    const handler = createHandler({ cloudBaseUrl: mock.url });
    const env = { IP_LIMITER: { limit: async () => ({ success: true }) }, KEY_LIMITER: { limit: async () => ({ success: true }) } };
    const transport = new StreamableHTTPClientTransport(new URL("https://unifi-mcp.test/mcp"), {
      requestInit: { headers: { "X-UniFi-API-Key": KEY, "X-UniFi-Console-Id": "Dream Machine Pro" } },
      fetch: async (url, init) => handler(new Request(url, init as RequestInit), env),
    });
    const client = new Client({ name: "regression", version: "0.0.0" });
    await client.connect(transport);
    const r = await client.callTool({ name: "protect_get_nvr", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(hitConsole(FLEET.udmPro)).toBe(true);
    await client.close();
  });
});
