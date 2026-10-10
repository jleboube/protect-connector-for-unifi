import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { z } from "zod";
import {
  UnifiClient,
  UnifiError,
  assertConsoleId,
  assertObjectId,
  bytesToBase64,
  hasProtectIntegrationApi,
  isUnifiError,
  listConsoles,
  looksLikeConsoleId,
  matchConsole,
  pickConsole,
  unwrapList,
  type ConsoleSummary,
} from "@unifi-mcp/core";
import { ENDPOINTS } from "./endpoints.js";
import {
  chimeLine,
  deviceName,
  formatCameraDetail,
  formatCameraList,
  formatDeviceList,
  formatNvr,
  formatStreams,
  lightLine,
  sensorLine,
  viewerLine,
} from "./format.js";

export const SERVER_NAME = "protect-connector-for-unifi";
export const SERVER_VERSION = "0.1.0";

type Obj = Record<string, unknown>;

/**
 * Optional cache mapping a console selector ("" = auto-pick, or a console name)
 * to a console id (per process / per isolate).
 */
export interface ConsoleCache {
  get(selector: string): Promise<string | undefined> | string | undefined;
  set(selector: string, consoleId: string): Promise<void> | void;
}

export interface ProtectServerOptions {
  client: UnifiClient;
  consoleCache?: ConsoleCache;
  /** Cloud mode: console to use when a tool call doesn't pass console_id (ID or name). */
  defaultConsole?: string;
  /** Pass CfWorkerJsonSchemaValidator in Workers (Ajv needs eval). */
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Shown in server instructions so the model knows how it's connected. */
  transportLabel?: string;
  /** When set, tools are listed but every call returns this message (e.g. no API key sent). */
  unconfiguredMessage?: string;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const consoleIdArg = z
  .string()
  .optional()
  .describe("Cloud mode only. Console ID or console name from unifi_list_consoles. Leave empty to use the configured console, or the only online Protect console.");

const cameraArg = z
  .string()
  .min(1)
  .describe('Camera id (from protect_list_cameras) or exact camera name, e.g. "Front Door".');

const INSTRUCTIONS = `Read-only access to a UniFi Protect system (cameras, snapshots, NVR, lights, chimes, sensors, viewers, existing RTSPS stream URLs). This connector cannot change anything in Protect.
Start with protect_list_cameras. Use protect_get_snapshot to see what a camera sees right now.
In cloud mode, if more than one console is visible, call unifi_list_consoles and pass console_id.
RTSPS URLs are secrets: only reveal them when the user explicitly asks, and never repeat them elsewhere.
Community project, not affiliated with or endorsed by Ubiquiti.`;

export function createProtectServer(opts: ProtectServerOptions): McpServer {
  const { client } = opts;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Protect Connector for UniFi (community)" },
    {
      instructions: INSTRUCTIONS + (opts.transportLabel ? `\nConnection: ${opts.transportLabel}.` : ""),
      capabilities: { tools: {} },
      ...(opts.jsonSchemaValidator ? { jsonSchemaValidator: opts.jsonSchemaValidator } : {}),
    },
  );

  // ---- helpers ----

  async function protectClient(consoleArg?: string): Promise<UnifiClient> {
    if (client.mode === "local") return client;
    const selector = consoleArg?.trim() || opts.defaultConsole?.trim() || client.selectedConsoleId || "";
    if (selector && looksLikeConsoleId(selector)) return client.withConsole(assertConsoleId(selector));
    const cached = await opts.consoleCache?.get(selector);
    if (cached) return client.withConsole(cached);
    const consoles = await listConsoles(client);
    const chosen = selector ? matchConsole(consoles, selector, "protect") : pickConsole(consoles, "protect");
    if (!chosen.apps.includes("protect")) {
      throw new UnifiError("config", `${chosen.name} doesn't have UniFi Protect installed.`, { hint: "Run unifi_list_consoles to see which consoles run Protect." });
    }
    if (!hasProtectIntegrationApi(chosen)) {
      throw new UnifiError("config", `${chosen.name} runs Protect ${chosen.protectVersion}, which predates Ubiquiti's Integration API (added in 5.3).`, { hint: "Update Protect on that console, or pick another one." });
    }
    await opts.consoleCache?.set(selector, chosen.id);
    return client.withConsole(chosen.id);
  }

  async function resolveCamera(c: UnifiClient, input: string): Promise<{ id: string; label: string; cam?: Obj }> {
    const trimmed = input.trim();
    if (/^[0-9a-f]{24}$/i.test(trimmed)) return { id: trimmed, label: `camera ${trimmed}` };
    const cams = unwrapList<Obj>(await c.getJson("protect", ENDPOINTS.cameras, { what: "listing cameras" }));
    const lower = trimmed.toLowerCase();
    const exact = cams.filter((x) => typeof x.name === "string" && x.name.toLowerCase() === lower);
    const byId = cams.filter((x) => x.id === trimmed);
    const partial = cams.filter((x) => typeof x.name === "string" && x.name.toLowerCase().includes(lower));
    const match = byId[0] ?? (exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined);
    if (match && typeof match.id === "string") return { id: match.id, label: `${deviceName(match)} (${match.id})`, cam: match };
    const options = (exact.length > 1 ? exact : partial.length > 1 ? partial : cams)
      .slice(0, 15)
      .map((x) => `${deviceName(x)} [${x.id}]`)
      .join("; ");
    throw new UnifiError(
      "not_found",
      exact.length > 1 || partial.length > 1 ? `"${trimmed}" matches more than one camera.` : `No camera named "${trimmed}".`,
      { hint: options ? `Cameras: ${options}.` : "Protect reports no cameras." },
    );
  }

  const run = async (fn: () => Promise<CallToolResult | string>): Promise<CallToolResult> => {
    if (opts.unconfiguredMessage) return { isError: true, content: [{ type: "text", text: opts.unconfiguredMessage }] };
    try {
      const out = await fn();
      return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
    } catch (e) {
      const text = isUnifiError(e)
        ? e.toUserMessage()
        : "Unexpected error while talking to UniFi Protect. Try again; if it keeps happening, report it on the project's GitHub issues.";
      return { isError: true, content: [{ type: "text", text }] };
    }
  };

  // ---- console discovery (cloud) ----

  if (client.mode === "cloud") {
    server.registerTool(
      "unifi_list_consoles",
      {
        title: "List UniFi consoles",
        description:
          "List the UniFi consoles (UniFi OS hosts such as a Dream Machine or Cloud Key) that this Site Manager API key can see, with their console IDs, online state and installed apps. Use it when a Protect tool says several consoles are visible, then pass console_id.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () =>
        run(async () => {
          const consoles = await listConsoles(client);
          if (consoles.length === 0) return "This key can't see any consoles. Use a Site Manager key created by the console owner at unifi.ui.com → Settings → API Keys.";
          const configured = opts.defaultConsole?.trim() || client.selectedConsoleId;
          const selected = configured && looksLikeConsoleId(configured) ? configured : await opts.consoleCache?.get(configured ?? "");
          const dupNames = new Set(consoles.map((c) => c.name).filter((n, i, a) => a.indexOf(n) !== i));
          const usable = consoles.filter((c) => c.apps.includes("protect") && c.connected && !c.isBlocked && hasProtectIntegrationApi(c));
          const lines = consoles.map((c: ConsoleSummary) => {
            const protect = c.protectVersion
              ? `Protect ${c.protectVersion}${hasProtectIntegrationApi(c) ? "" : " (too old for the API, needs 5.3+)"}`
              : undefined;
            const bits = [c.model, c.connected ? "online" : "OFFLINE", c.apps.length ? `apps: ${c.apps.join(", ")}` : "no apps reported", protect, c.isBlocked ? "BLOCKED" : undefined].filter(Boolean);
            return `- ${c.name}${dupNames.has(c.name) && c.hostname ? ` [host ${c.hostname}]` : ""}${c.id === selected ? " (selected)" : ""} — ${bits.join(" · ")} [console_id ${c.id}]`;
          });
          const footer =
            usable.length === 1
              ? `Protect tools will use ${usable[0].name} automatically.`
              : usable.length > 1
                ? `${usable.length} online consoles run Protect; pass console_id (ID or name) or set UNIFI_CONSOLE_ID.`
                : "No online console runs a Protect version with the Integration API.";
          return [`${consoles.length} console${consoles.length === 1 ? "" : "s"}:`, ...lines, footer].join("\n");
        }),
    );
  }

  // ---- Protect ----

  server.registerTool(
    "protect_get_info",
    {
      title: "Protect version and NVR",
      description: "Show the UniFi Protect application version and the NVR (console) name, model and alarm arm state. Good first call to confirm the connection works.",
      inputSchema: { console_id: consoleIdArg },
      annotations: READ_ONLY,
    },
    async ({ console_id }) =>
      run(async () => {
        const c = await protectClient(console_id);
        const info = await c.getJson<Obj>("protect", ENDPOINTS.metaInfo, { what: "Protect info" });
        const nvr = await c.getJson<Obj>("protect", ENDPOINTS.nvrs, { what: "NVR details" });
        const nvrObj = Array.isArray(nvr) ? (nvr[0] as Obj) ?? {} : nvr ?? {};
        const version = typeof info?.applicationVersion === "string" ? info.applicationVersion : undefined;
        const mode = c.mode === "cloud" ? `cloud connector (console ${c.selectedConsoleId})` : "local network";
        return `${formatNvr(nvrObj, version)}\nconnected via: ${mode}`;
      }),
  );

  server.registerTool(
    "protect_list_cameras",
    {
      title: "List cameras",
      description:
        "List every camera adopted in UniFi Protect with online/offline state, model, which smart detections (person, vehicle, animal, package, face, license plate) are turned on, and its id. Optional filters by name or state.",
      inputSchema: {
        name_contains: z.string().optional().describe("Only cameras whose name contains this text (case-insensitive)."),
        state: z.enum(["any", "online", "offline"]).optional().describe("Only online or only offline cameras. Default any."),
        console_id: consoleIdArg,
      },
      annotations: READ_ONLY,
    },
    async ({ name_contains, state, console_id }) =>
      run(async () => {
        const c = await protectClient(console_id);
        let cams = unwrapList<Obj>(await c.getJson("protect", ENDPOINTS.cameras, { what: "listing cameras" }));
        const filters: string[] = [];
        if (name_contains) {
          const n = name_contains.toLowerCase();
          cams = cams.filter((x) => typeof x.name === "string" && x.name.toLowerCase().includes(n));
          filters.push(name_contains);
        }
        if (state && state !== "any") {
          cams = cams.filter((x) => (state === "online" ? x.state === "CONNECTED" : x.state !== "CONNECTED"));
          filters.push(state);
        }
        cams.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
        return formatCameraList(cams, filters.length ? filters.join(", ") : undefined);
      }),
  );

  server.registerTool(
    "protect_get_camera",
    {
      title: "Camera details",
      description: "Show one camera's details: state, model, enabled and supported smart detections, features (package camera, HDR, mic, full-HD snapshots), video mode and doorbell message.",
      inputSchema: { camera: cameraArg, console_id: consoleIdArg },
      annotations: READ_ONLY,
    },
    async ({ camera, console_id }) =>
      run(async () => {
        const c = await protectClient(console_id);
        const resolved = await resolveCamera(c, camera);
        // Camera objects in the list are complete, so skip the second call when we already have it.
        const cam = resolved.cam ?? (await c.getJson<Obj>("protect", ENDPOINTS.camera(assertObjectId(resolved.id, "camera id")), { what: resolved.label }));
        return formatCameraDetail(cam ?? {});
      }),
  );

  server.registerTool(
    "protect_get_snapshot",
    {
      title: "Camera snapshot",
      description:
        "Get a live JPEG snapshot from a camera, returned as an image you can look at. Use channel=package for the downward package camera on doorbells that have one. high_quality asks for 1080p or better (not every camera supports it). Some newer cameras return full-resolution 4K (~1 MB) even by default, so fetch snapshots only when you need to look.",
      inputSchema: {
        camera: cameraArg,
        channel: z.enum(["main", "package"]).optional().describe("main (default) or package (doorbells with a package camera)."),
        high_quality: z.boolean().optional().describe("Request a 1080p+ snapshot. Default false."),
        console_id: consoleIdArg,
      },
      annotations: READ_ONLY,
    },
    async ({ camera, channel, high_quality, console_id }) =>
      run(async () => {
        const c = await protectClient(console_id);
        const { id, label } = await resolveCamera(c, camera);
        let img;
        try {
          img = await c.getBinary("protect", ENDPOINTS.snapshot(assertObjectId(id, "camera id")), {
            query: { channel: channel && channel !== "main" ? channel : undefined, highQuality: high_quality ? true : undefined },
            what: `snapshot from ${label}`,
            accept: "image/jpeg",
          });
        } catch (e) {
          if (isUnifiError(e) && e.status === 503) {
            throw new UnifiError("offline", `${label} is offline or not reachable, so there's no snapshot.`);
          }
          if (isUnifiError(e) && e.status === 400 && high_quality) {
            throw new UnifiError("upstream", `${label} doesn't support high-quality snapshots.`, { hint: "Try again with high_quality=false." });
          }
          throw e;
        }
        if (!img.contentType.startsWith("image/")) {
          throw new UnifiError("upstream", `Protect didn't return an image for ${label}.`);
        }
        const takenAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        return {
          content: [
            { type: "image", data: bytesToBase64(img.bytes), mimeType: img.contentType },
            { type: "text", text: `Snapshot from ${label}, ${channel ?? "main"} channel${high_quality ? ", high quality" : ""}, taken ${takenAt} (${Math.round(img.bytes.byteLength / 1024)} KB).` },
          ],
        };
      }),
  );

  server.registerTool(
    "protect_get_nvr",
    {
      title: "NVR details",
      description: "Show the Protect NVR (the console recording the cameras): name, model, alarm arm status and default doorbell message.",
      inputSchema: { console_id: consoleIdArg },
      annotations: READ_ONLY,
    },
    async ({ console_id }) =>
      run(async () => {
        const c = await protectClient(console_id);
        const nvr = await c.getJson<Obj>("protect", ENDPOINTS.nvrs, { what: "NVR details" });
        return formatNvr(Array.isArray(nvr) ? (nvr[0] as Obj) ?? {} : nvr ?? {});
      }),
  );

  const deviceKinds = {
    light: { list: ENDPOINTS.lights, one: ENDPOINTS.light, line: lightLine, label: "light" },
    chime: { list: ENDPOINTS.chimes, one: ENDPOINTS.chime, line: chimeLine, label: "chime" },
    sensor: { list: ENDPOINTS.sensors, one: ENDPOINTS.sensor, line: sensorLine, label: "sensor" },
    viewer: { list: ENDPOINTS.viewers, one: ENDPOINTS.viewer, line: viewerLine, label: "viewer" },
  } as const;

  const listTool = (
    name: string,
    title: string,
    description: string,
    kind: keyof typeof deviceKinds,
  ) =>
    server.registerTool(
      name,
      { title, description, inputSchema: { console_id: consoleIdArg }, annotations: READ_ONLY },
      async ({ console_id }) =>
        run(async () => {
          const k = deviceKinds[kind];
          const c = await protectClient(console_id);
          const items = unwrapList<Obj>(await c.getJson("protect", k.list, { what: `listing ${k.label}s` }));
          items.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
          return formatDeviceList(k.label, items, k.line);
        }),
    );

  listTool("protect_list_lights", "List floodlights", "List UniFi Protect floodlights with online state, whether the light is on, light mode, last motion and brightness.", "light");
  listTool("protect_list_chimes", "List chimes", "List UniFi Protect doorbell chimes with online state, number of paired doorbells and ring volume.", "chime");
  listTool(
    "protect_list_sensors",
    "List sensors",
    "List UniFi Protect sensors with online state, mount type, open/closed, motion, leak, tamper and alarm status, temperature, humidity, light level and battery.",
    "sensor",
  );
  listTool("protect_list_viewers", "List viewers", "List UniFi Protect Viewport displays with online state and the live view each one shows.", "viewer");

  server.registerTool(
    "protect_get_device",
    {
      title: "Light, chime, sensor or viewer details",
      description: "Show one light, chime, sensor or viewer by id (ids come from the matching protect_list_* tool).",
      inputSchema: {
        kind: z.enum(["light", "chime", "sensor", "viewer"]).describe("Device type."),
        id: z.string().min(1).describe("Device id from the list tool."),
        console_id: consoleIdArg,
      },
      annotations: READ_ONLY,
    },
    async ({ kind, id, console_id }) =>
      run(async () => {
        const k = deviceKinds[kind];
        const c = await protectClient(console_id);
        const item = await c.getJson<Obj>("protect", k.one(assertObjectId(id.trim(), `${k.label} id`)), { what: `${k.label} ${id}` });
        const o = item ?? {};
        const extra = [typeof o.mac === "string" ? `mac: ${o.mac}` : undefined, typeof o.type === "string" ? `model: ${o.type}` : undefined].filter(Boolean);
        return [k.line(o).replace(/^- /, `${k.label[0].toUpperCase()}${k.label.slice(1)}: `), ...extra].join("\n");
      }),
  );

  server.registerTool(
    "protect_get_stream_urls",
    {
      title: "Existing RTSPS stream URLs (sensitive)",
      description:
        "SENSITIVE. Show the RTSPS live-stream URLs that are already enabled for a camera (high/medium/low/package). The URLs work without a password for anyone who can reach the console, so they're masked unless reveal=true. Only use reveal=true when the user explicitly asks for the full URL, and never post the URLs anywhere else. This tool never creates streams.",
      inputSchema: {
        camera: cameraArg,
        reveal: z.boolean().optional().describe("Show full URLs instead of masked ones. Default false. Only when the user explicitly asks."),
        console_id: consoleIdArg,
      },
      annotations: READ_ONLY,
    },
    async ({ camera, reveal, console_id }) =>
      run(async () => {
        const c = await protectClient(console_id);
        const { id, label } = await resolveCamera(c, camera);
        const streams = await c.getJson<Obj>("protect", ENDPOINTS.rtspsStreams(assertObjectId(id, "camera id")), { what: `RTSPS streams for ${label}` });
        return formatStreams(label, streams ?? {}, reveal === true);
      }),
  );

  return server;
}
