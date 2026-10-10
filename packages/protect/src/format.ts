/**
 * Turn Protect API objects into short, readable text. Tools return these
 * summaries instead of raw JSON so answers stay compact.
 */

type Obj = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function deviceName(d: Obj): string {
  return str(typeof d.name === "string" ? d.name.trim() : undefined) ?? `(unnamed ${str(d.modelKey) ?? "device"})`;
}

export function stateLabel(state: unknown): string {
  switch (state) {
    case "CONNECTED":
      return "online";
    case "CONNECTING":
      return "connecting";
    case "DISCONNECTED":
      return "OFFLINE";
    default:
      return str(state)?.toLowerCase() ?? "unknown";
  }
}

export function formatTime(ms: unknown): string | undefined {
  const n = num(ms);
  if (!n) return undefined;
  return new Date(n).toISOString().replace(".000Z", "Z");
}

function countByState(items: Obj[]): string {
  const online = items.filter((i) => i.state === "CONNECTED").length;
  const offline = items.filter((i) => i.state === "DISCONNECTED").length;
  const other = items.length - online - offline;
  const parts = [`${online} online`];
  if (offline) parts.push(`${offline} offline`);
  if (other) parts.push(`${other} connecting`);
  return parts.join(", ");
}

// ---------- cameras ----------

export function cameraLine(c: Obj): string {
  const ff = obj(c.featureFlags);
  const sds = obj(c.smartDetectSettings);
  const enabledTypes = arr(sds.objectTypes).filter((x): x is string => typeof x === "string");
  const supported = arr(ff.smartDetectTypes).filter((x): x is string => typeof x === "string");
  const bits = [stateLabel(c.state)];
  if (str(c.type)) bits.push(str(c.type)!);
  if (enabledTypes.length) bits.push(`detects ${enabledTypes.join("/")}`);
  else if (supported.length) bits.push(`smart detect available (${supported.join("/")}) but none enabled`);
  else bits.push("no smart detection");
  if (c.hasPackageCamera === true) bits.push("package camera");
  if (num(c.activePatrolSlot) !== undefined) bits.push(`PTZ patrol slot ${c.activePatrolSlot}`);
  return `- ${deviceName(c)} — ${bits.join(" · ")} [id ${str(c.id) ?? "?"}]`;
}

export function formatCameraList(cams: Obj[], filter?: string): string {
  if (cams.length === 0) return filter ? `No cameras match "${filter}".` : "No cameras are adopted in Protect.";
  const header = `${cams.length} camera${cams.length === 1 ? "" : "s"} (${countByState(cams)})${filter ? ` matching "${filter}"` : ""}:`;
  return [header, ...cams.map(cameraLine)].join("\n");
}

export function formatCameraDetail(c: Obj): string {
  const ff = obj(c.featureFlags);
  const sds = obj(c.smartDetectSettings);
  const lines = [`Camera: ${deviceName(c)} (${stateLabel(c.state)})`, `id: ${str(c.id) ?? "?"}`];
  if (str(c.type)) lines.push(`model: ${c.type}`);
  if (str(c.mac)) lines.push(`mac: ${c.mac}`);
  const objTypes = arr(sds.objectTypes).join(", ");
  const audioTypes = arr(sds.audioTypes).join(", ");
  lines.push(`smart detection enabled: ${objTypes || "none"}${audioTypes ? `; audio: ${audioTypes}` : ""}`);
  const supported = arr(ff.smartDetectTypes).join(", ");
  if (supported) lines.push(`smart detection supported: ${supported}`);
  const caps: string[] = [];
  if (bool(ff.supportFullHdSnapshot)) caps.push("full-HD snapshots");
  if (bool(ff.hasHdr)) caps.push("HDR");
  if (bool(ff.hasMic)) caps.push("mic");
  if (bool(ff.hasSpeaker)) caps.push("speaker");
  if (c.hasPackageCamera === true) caps.push("package camera (use channel=package)");
  if (caps.length) lines.push(`features: ${caps.join(", ")}`);
  if (str(c.videoMode)) lines.push(`video mode: ${c.videoMode}${str(c.hdrType) ? `, HDR ${c.hdrType}` : ""}`);
  if (bool(c.isMicEnabled) !== undefined) lines.push(`microphone: ${c.isMicEnabled ? "on" : "off"}${num(c.micVolume) !== undefined ? ` (volume ${c.micVolume})` : ""}`);
  const led = obj(c.ledSettings);
  if (bool(led.isEnabled) !== undefined) lines.push(`status LED: ${led.isEnabled ? "on" : "off"}`);
  const lcd = obj(c.lcdMessage);
  if (str(lcd.type)) lines.push(`doorbell message: ${lcd.type}${str(lcd.text) ? ` "${lcd.text}"` : ""}`);
  if (num(c.activePatrolSlot) !== undefined) lines.push(`PTZ patrol active: slot ${c.activePatrolSlot}`);
  return lines.join("\n");
}

// ---------- NVR ----------

export function formatNvr(n: Obj, appVersion?: string): string {
  const lines = [`NVR: ${deviceName(n)}`];
  if (str(n.type)) lines.push(`model: ${n.type}`);
  if (appVersion) lines.push(`Protect version: ${appVersion}`);
  if (str(n.id)) lines.push(`id: ${n.id}`);
  const arm = obj(n.armMode);
  if (str(arm.status)) {
    let s = `alarm arm mode: ${arm.status}`;
    if (formatTime(arm.armedAt)) s += ` (armed at ${formatTime(arm.armedAt)})`;
    if (arm.status === "breach" && formatTime(arm.breachDetectedAt)) s += `, breach at ${formatTime(arm.breachDetectedAt)}`;
    lines.push(s);
  }
  const db = obj(n.doorbellSettings);
  if (str(db.defaultMessageText)) lines.push(`default doorbell message: "${db.defaultMessageText}"`);
  return lines.join("\n");
}

// ---------- other devices ----------

export function lightLine(l: Obj): string {
  const mode = obj(l.lightModeSettings);
  const dev = obj(l.lightDeviceSettings);
  const bits = [stateLabel(l.state), l.isLightOn ? "light ON" : "light off"];
  if (str(mode.mode)) bits.push(`mode ${mode.mode}${str(mode.enableAt) ? ` (${mode.enableAt})` : ""}`);
  if (l.isPirMotionDetected === true) bits.push("motion now");
  else if (formatTime(l.lastMotion)) bits.push(`last motion ${formatTime(l.lastMotion)}`);
  if (num(dev.ledLevel) !== undefined) bits.push(`brightness ${dev.ledLevel}/6`);
  if (str(l.camera)) bits.push(`paired camera ${l.camera}`);
  return `- ${deviceName(l)} — ${bits.join(" · ")} [id ${str(l.id) ?? "?"}]`;
}

export function chimeLine(c: Obj): string {
  const cams = arr(c.cameraIds).length;
  const rings = arr(c.ringSettings).map(obj);
  const vol = rings.length ? ` · volume ${rings.map((r) => num(r.volume) ?? "?").join("/")}` : "";
  return `- ${deviceName(c)} — ${stateLabel(c.state)} · ${cams} paired doorbell${cams === 1 ? "" : "s"}${vol} [id ${str(c.id) ?? "?"}]`;
}

export function sensorLine(s: Obj): string {
  const bits = [stateLabel(s.state)];
  if (str(s.mountType) && s.mountType !== "none") bits.push(`${s.mountType} sensor`);
  if (bool(s.isOpened) !== undefined && s.isOpened !== null) bits.push(s.isOpened ? "OPEN" : "closed");
  if (s.isMotionDetected === true) bits.push("motion now");
  if (formatTime(s.leakDetectedAt)) bits.push(`LEAK at ${formatTime(s.leakDetectedAt)}`);
  if (formatTime(s.tamperingDetectedAt)) bits.push(`tampered at ${formatTime(s.tamperingDetectedAt)}`);
  if (formatTime(s.alarmTriggeredAt)) bits.push(`alarm at ${formatTime(s.alarmTriggeredAt)}`);
  const stats = obj(s.stats);
  const t = num(obj(stats.temperature).value);
  const h = num(obj(stats.humidity).value);
  const lux = num(obj(stats.light).value);
  if (t !== undefined) bits.push(`${t}°C`);
  if (h !== undefined) bits.push(`${h}% RH`);
  if (lux !== undefined) bits.push(`${lux} lux`);
  const bat = obj(s.batteryStatus);
  if (num(bat.percentage) !== undefined) bits.push(`battery ${bat.percentage}%${bat.isLow ? " (LOW)" : ""}`);
  else if (bat.isLow === true) bits.push("battery LOW");
  return `- ${deviceName(s)} — ${bits.join(" · ")} [id ${str(s.id) ?? "?"}]`;
}

export function viewerLine(v: Obj): string {
  const bits = [stateLabel(v.state)];
  if (str(v.type)) bits.push(str(v.type)!);
  bits.push(str(v.liveview) ? `showing live view ${v.liveview}` : "no live view assigned");
  if (num(v.streamLimit) !== undefined) bits.push(`stream limit ${v.streamLimit}`);
  return `- ${deviceName(v)} — ${bits.join(" · ")} [id ${str(v.id) ?? "?"}]`;
}

export function formatDeviceList(kind: string, items: Obj[], line: (o: Obj) => string): string {
  if (items.length === 0) return `No ${kind}s are adopted in Protect.`;
  return [`${items.length} ${kind}${items.length === 1 ? "" : "s"} (${countByState(items)}):`, ...items.map(line)].join("\n");
}

// ---------- RTSPS ----------

export const STREAM_WARNING =
  "SENSITIVE: anyone who can reach the console with one of these RTSPS URLs can watch the live video without logging in. Don't paste them into chats, tickets, docs or logs, and remove them in Protect if they leak.";

/** Mask the secret path token of an rtsps URL: rtsps://h:7441/5nPr••••••?enableSrtp */
export function maskStreamUrl(url: string): string {
  const m = /^(rtsps?:\/\/[^/]+\/)([^?]+)(.*)$/i.exec(url);
  if (!m) return "(hidden)";
  const token = m[2];
  return `${m[1]}${token.slice(0, 4)}${"•".repeat(Math.max(4, token.length - 4))}${m[3]}`;
}

export function formatStreams(cameraLabel: string, streams: Obj, reveal: boolean): string {
  const qualities = ["high", "medium", "low", "package"] as const;
  const present = qualities.filter((q) => str(streams[q]));
  if (present.length === 0) {
    return `${cameraLabel} has no RTSPS streams enabled. Creating one is a write, which this read-only connector doesn't do. A Protect admin can turn on RTSPS for the camera in Protect (camera settings → Advanced → RTSPS).`;
  }
  const lines = [STREAM_WARNING, `RTSPS streams for ${cameraLabel}${reveal ? "" : " (masked; pass reveal=true for the full URLs)"}:`];
  for (const q of present) {
    const url = streams[q] as string;
    lines.push(`- ${q}: ${reveal ? url : maskStreamUrl(url)}`);
  }
  const missing = qualities.filter((q) => !str(streams[q]) && q !== "package");
  if (missing.length) lines.push(`Not enabled: ${missing.join(", ")}.`);
  return lines.join("\n");
}
