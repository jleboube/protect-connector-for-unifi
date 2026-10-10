import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockProtect, fixtures, MOCK_JPEG_BASE64, type MockProtect } from "@unifi-mcp/mock-protect";
import { UnifiClient } from "@unifi-mcp/core";
import { connect, textOf } from "./helpers.js";

const KEY = "test-key";
const EXPECTED_TOOLS = [
  "protect_get_camera",
  "protect_get_device",
  "protect_get_info",
  "protect_get_nvr",
  "protect_get_snapshot",
  "protect_get_stream_urls",
  "protect_list_cameras",
  "protect_list_chimes",
  "protect_list_lights",
  "protect_list_sensors",
  "protect_list_viewers",
];

let mock: MockProtect;
beforeEach(async () => {
  mock = await startMockProtect({ apiKey: KEY });
});
afterEach(async () => {
  await mock.close();
});

describe("MCP server, local mode", () => {
  const local = () => new UnifiClient({ apiKey: KEY, mode: "local", host: mock.url });

  it("lists only read-only tools", async () => {
    const s = await connect(local());
    const { tools } = await s.mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.description && t.description.length > 40, t.name).toBe(true);
      expect(t.name).not.toMatch(/create|delete|set|update|patch|trigger|ptz|play|arm/);
    }
    await s.close();
  });

  it("never sends anything but GET upstream", async () => {
    const s = await connect(local());
    for (const name of ["protect_get_info", "protect_list_cameras", "protect_list_lights", "protect_list_chimes", "protect_list_sensors", "protect_list_viewers", "protect_get_nvr"]) {
      const r = await s.call(name);
      expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
    }
    await s.call("protect_get_snapshot", { camera: "Front Door" });
    await s.call("protect_get_stream_urls", { camera: "Front Door" });
    expect(mock.requests.every((r) => r.method === "GET")).toBe(true);
    await s.close();
  });

  it("lists cameras compactly with filters", async () => {
    const s = await connect(local());
    const all = textOf(await s.call("protect_list_cameras"));
    expect(all).toMatch(/^4 cameras \(3 online, 1 offline\):/);
    expect(all).not.toContain('"featureFlags"');
    const offline = textOf(await s.call("protect_list_cameras", { state: "offline" }));
    expect(offline).toContain("Garage");
    expect(offline).not.toContain("Driveway");
    const byName = textOf(await s.call("protect_list_cameras", { name_contains: "drive" }));
    expect(byName).toMatch(/^1 camera/);
    await s.close();
  });

  it("gets a camera by name or id", async () => {
    const s = await connect(local());
    const byName = textOf(await s.call("protect_get_camera", { camera: "front door" }));
    expect(byName).toContain("Camera: Front Door (online)");
    expect(byName).toContain("smart detection enabled: person, package");
    const byId = textOf(await s.call("protect_get_camera", { camera: fixtures.CAMERA_DRIVEWAY }));
    expect(byId).toContain("Camera: Driveway");
    const missing = await s.call("protect_get_camera", { camera: "Pool" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No camera named "Pool".*Front Door/);
    await s.close();
  });

  it("returns snapshots as MCP image content", async () => {
    const s = await connect(local());
    const r = await s.call("protect_get_snapshot", { camera: "Front Door", channel: "package", high_quality: true });
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.data).toBe(MOCK_JPEG_BASE64);
    expect(textOf(r)).toMatch(/Snapshot from Front Door .* package channel, high quality/);
    expect(mock.requests.at(-1)?.url).toBe(`/proxy/protect/integration/v1/cameras/${fixtures.CAMERA_FRONT}/snapshot?channel=package&highQuality=true`);
    await s.close();
  });

  it("explains offline cameras and unsupported HQ snapshots", async () => {
    const s = await connect(local());
    const offline = await s.call("protect_get_snapshot", { camera: "Garage" });
    expect(offline.isError).toBe(true);
    expect(textOf(offline)).toMatch(/Garage.*offline/);
    const hq = await s.call("protect_get_snapshot", { camera: "Driveway", high_quality: true });
    expect(hq.isError).toBe(true);
    expect(textOf(hq)).toMatch(/doesn't support high-quality/);
    await s.close();
  });

  it("masks stream URLs unless reveal=true, and labels them sensitive", async () => {
    const s = await connect(local());
    const masked = textOf(await s.call("protect_get_stream_urls", { camera: "Front Door" }));
    expect(masked).toMatch(/^SENSITIVE/);
    expect(masked).not.toContain("5nPr7RCmueGTKMP7");
    const full = textOf(await s.call("protect_get_stream_urls", { camera: "Front Door", reveal: true }));
    expect(full).toContain("rtsps://192.168.1.1:7441/5nPr7RCmueGTKMP7?enableSrtp");
    const none = textOf(await s.call("protect_get_stream_urls", { camera: "Driveway" }));
    expect(none).toMatch(/no RTSPS streams enabled/);
    await s.close();
  });

  it("reads devices", async () => {
    const s = await connect(local());
    expect(textOf(await s.call("protect_list_sensors"))).toContain("Back Door — online · door sensor · OPEN");
    expect(textOf(await s.call("protect_list_lights"))).toContain("Backyard Flood");
    expect(textOf(await s.call("protect_list_chimes"))).toContain("1 paired doorbell");
    expect(textOf(await s.call("protect_list_viewers"))).toContain("Kitchen Viewport");
    const one = textOf(await s.call("protect_get_device", { kind: "sensor", id: fixtures.sensors[0].id }));
    expect(one).toMatch(/^Sensor: Back Door/);
    const bad = await s.call("protect_get_device", { kind: "light", id: "../../nvrs" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/isn't a valid light id/);
    await s.close();
  });

  it("shows Protect version and NVR", async () => {
    const s = await connect(local());
    const info = textOf(await s.call("protect_get_info"));
    expect(info).toContain("NVR: Home UDM Pro");
    expect(info).toContain("Protect version: 7.2.105");
    expect(info).toContain("connected via: local network");
    await s.close();
  });

  it("handles endpoints missing on older firmware with a friendly 404", async () => {
    mock.options.missingPaths = ["/v1/viewers"];
    const s = await connect(local());
    const r = await s.call("protect_list_viewers");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Not found \(listing viewers\).*newer than your Protect version/);
    await s.close();
  });

  it("reports a wrong key clearly", async () => {
    const s = await connect(new UnifiClient({ apiKey: "wrong", mode: "local", host: mock.url }));
    const r = await s.call("protect_list_cameras");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/refused the API key.*Control Plane → Integrations/);
    await s.close();
  });
});

describe("MCP server, cloud mode", () => {
  const cloud = (consoleId?: string) => new UnifiClient({ apiKey: KEY, mode: "cloud", cloudBaseUrl: mock.url, consoleId });

  it("adds console discovery and auto-selects the only Protect console", async () => {
    const cache: { v?: string } = {};
    const s = await connect(cloud(), cache);
    const { tools } = await s.mcp.listTools();
    expect(tools.map((t) => t.name)).toContain("unifi_list_consoles");
    const consoles = textOf(await s.call("unifi_list_consoles"));
    expect(consoles).toContain("Home UDM Pro");
    expect(consoles).toContain(`console_id ${fixtures.CONSOLE_ID_HOME}`);
    expect(consoles).toContain("Protect 7.2.105");
    const cams = await s.call("protect_list_cameras");
    expect(cams.isError, textOf(cams)).toBeFalsy();
    expect(cache.v).toBe(fixtures.CONSOLE_ID_HOME);
    expect(mock.requests.some((r) => r.url.startsWith(`/v1/connector/consoles/${fixtures.CONSOLE_ID_HOME}/proxy/protect/integration/v1/cameras`))).toBe(true);
    const info = textOf(await s.call("protect_get_info"));
    expect(info).toContain(`cloud connector (console ${fixtures.CONSOLE_ID_HOME})`);
    await s.close();
  });

  it("asks the user to choose when several consoles are visible", async () => {
    mock.options.hosts = "two";
    const s = await connect(cloud());
    const r = await s.call("protect_list_cameras");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/2 online consoles running protect.*Pass console_id/);
    const ok = await s.call("protect_list_cameras", { console_id: fixtures.CONSOLE_ID_CABIN });
    expect(ok.isError).toBeFalsy();
    await s.close();
  });

  it("rejects malformed console ids", async () => {
    const s = await connect(cloud());
    const r = await s.call("protect_list_cameras", { console_id: "x/../../hosts" });
    expect(r.isError).toBe(true);
    // Treated as a name lookup; it never reaches a URL.
    expect(textOf(r)).toMatch(/No console named/);
    expect(mock.requests.some((q) => q.url.includes("x/") || q.url.includes(".."))).toBe(false);
    await s.close();
  });

  it("explains Remote Access when the connector can't reach the console", async () => {
    mock.options.consoleOffline = true;
    const s = await connect(cloud(fixtures.CONSOLE_ID_HOME));
    const r = await s.call("protect_list_cameras");
    expect(textOf(r)).toMatch(/Remote Access/);
    await s.close();
  });
});
