import { describe, expect, it } from "vitest";
import { fixtures } from "@unifi-mcp/mock-protect";
import { cameraLine, formatCameraList, formatStreams, maskStreamUrl, sensorLine, STREAM_WARNING } from "../src/format.js";

describe("format", () => {
  it("summarises cameras compactly", () => {
    const line = cameraLine(fixtures.cameras[0]);
    expect(line).toContain("Front Door");
    expect(line).toContain("online");
    expect(line).toContain("detects person/package");
    expect(line).toContain("package camera");
    expect(line).toContain(fixtures.CAMERA_FRONT);
    const list = formatCameraList(fixtures.cameras);
    expect(list.split("\n")[0]).toBe("4 cameras (3 online, 1 offline):");
    expect(list).toContain("Garage — OFFLINE");
    expect(list).not.toContain("{");
  });

  it("masks stream URLs by default", () => {
    expect(maskStreamUrl("rtsps://192.168.1.1:7441/5nPr7RCmueGTKMP7?enableSrtp")).toBe("rtsps://192.168.1.1:7441/5nPr••••••••••••?enableSrtp");
    const masked = formatStreams("Front Door", fixtures.rtspsStreams[fixtures.CAMERA_FRONT], false);
    expect(masked).toContain(STREAM_WARNING);
    expect(masked).not.toContain("5nPr7RCmueGTKMP7");
    expect(masked).toContain("Not enabled: medium, low.");
    const revealed = formatStreams("Front Door", fixtures.rtspsStreams[fixtures.CAMERA_FRONT], true);
    expect(revealed).toContain("5nPr7RCmueGTKMP7");
    expect(revealed).toContain("SENSITIVE");
  });

  it("explains when no streams exist", () => {
    expect(formatStreams("Garage", { high: null }, false)).toMatch(/no RTSPS streams enabled.*read-only/);
  });

  it("summarises sensors", () => {
    const s = sensorLine(fixtures.sensors[0]);
    expect(s).toContain("door sensor");
    expect(s).toContain("OPEN");
    expect(s).toContain("21.5°C");
    expect(s).toContain("battery 15% (LOW)");
  });
});
