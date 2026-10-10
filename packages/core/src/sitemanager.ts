import { UnifiError } from "./errors.js";
import { unwrapList, type UnifiClient } from "./client.js";

/** Compact view of a Site Manager host (console). */
export interface ConsoleSummary {
  id: string;
  name: string;
  hostname?: string;
  model?: string;
  type?: string;
  /** "connected"/"disconnected" when reported */
  state?: string;
  connected: boolean;
  isOwner?: boolean;
  isBlocked?: boolean;
  /** UniFi apps actually installed on the console, e.g. ["network", "protect"] */
  apps: string[];
  firmware?: string;
  protectVersion?: string;
}

interface RawController {
  name?: string;
  version?: string | null;
  state?: string;
  isInstalled?: boolean;
}

interface RawHost {
  id?: string;
  type?: string;
  owner?: boolean;
  isBlocked?: boolean;
  userData?: { controllers?: unknown; name?: string } | null;
  reportedState?: {
    name?: string;
    hostname?: string;
    state?: string;
    version?: string;
    hardware?: { name?: string; shortname?: string } | null;
    controllers?: RawController[] | null;
  } | null;
}

/** Protect added the official Integration API in 5.3.x. */
export const PROTECT_INTEGRATION_API_MIN = "5.3.0";

export function summariseHost(h: RawHost): ConsoleSummary | undefined {
  if (!h || typeof h.id !== "string") return undefined;
  const rs = h.reportedState ?? {};
  const apps = new Set<string>();
  const controllers = Array.isArray(rs.controllers) ? rs.controllers : undefined;
  if (controllers) {
    // userData.controllers lists apps the console *supports*; only trust installed ones.
    for (const c of controllers) if (c?.name && c.isInstalled === true) apps.add(c.name);
  } else if (Array.isArray(h.userData?.controllers)) {
    for (const c of h.userData!.controllers as unknown[]) if (typeof c === "string") apps.add(c);
  }
  const protect = controllers?.find((c) => c?.name === "protect" && c.isInstalled === true);
  const state = typeof rs.state === "string" ? rs.state : undefined;
  return {
    id: h.id,
    name: (rs.name || rs.hostname || h.userData?.name || "(unnamed console)").trim(),
    hostname: rs.hostname?.trim() || undefined,
    model: rs.hardware?.name ?? rs.hardware?.shortname,
    type: h.type,
    state,
    connected: state === undefined ? true : state.toLowerCase() === "connected",
    isOwner: h.owner,
    isBlocked: h.isBlocked,
    apps: [...apps].sort(),
    firmware: rs.version,
    protectVersion: protect?.version || undefined,
  };
}

/** Compare dotted versions; returns <0, 0, >0. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True if the console's Protect is new enough for the Integration API (unknown → true). */
export function hasProtectIntegrationApi(c: ConsoleSummary): boolean {
  return !c.protectVersion || compareVersions(c.protectVersion, PROTECT_INTEGRATION_API_MIN) >= 0;
}

/** List consoles visible to a Site Manager API key (follows nextToken paging, capped). */
export async function listConsoles(client: UnifiClient, maxPages = 5): Promise<ConsoleSummary[]> {
  const out: ConsoleSummary[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const payload = await client.siteManagerGet<{ data?: unknown; nextToken?: string }>("/v1/hosts", {
      query: { pageSize: 100, nextToken },
      what: "listing consoles",
    });
    for (const h of unwrapList<RawHost>(payload)) {
      const s = summariseHost(h);
      if (s) out.push(s);
    }
    nextToken = typeof payload?.nextToken === "string" && payload.nextToken ? payload.nextToken : undefined;
    if (!nextToken) break;
  }
  return out;
}

/** Strict-ish test for a Site Manager console id ("<hex>:<digits>"). */
export function looksLikeConsoleId(s: string): boolean {
  return /^[0-9A-Fa-f]{16,}:\d+$/.test(s.trim());
}

function describe(c: ConsoleSummary): string {
  const bits = [c.model, c.connected ? "online" : "offline", c.protectVersion ? `Protect ${c.protectVersion}` : undefined].filter(Boolean);
  return `${c.name} (${bits.join(", ")}; console_id ${c.id})`;
}

/** Narrow to consoles that can serve `app`: installed, not blocked, connected, new enough. */
function usableFor(consoles: ConsoleSummary[], app: string): ConsoleSummary[] {
  return consoles.filter(
    (c) => !c.isBlocked && c.apps.includes(app) && c.connected && (app !== "protect" || hasProtectIntegrationApi(c)),
  );
}

/**
 * Pick the console to use when the caller didn't name one. Only picks when
 * exactly one console is online with the app installed; otherwise asks.
 */
export function pickConsole(consoles: ConsoleSummary[], app: string): ConsoleSummary {
  const usable = usableFor(consoles, app);
  if (usable.length === 1) return usable[0];
  if (usable.length === 0) {
    const installed = consoles.filter((c) => c.apps.includes(app));
    if (installed.length === 0) {
      throw new UnifiError("config", `None of the ${consoles.length} console(s) this key can see has ${app} installed.`, {
        hint: consoles.length === 0 ? "Use a Site Manager key from unifi.ui.com → Settings → API Keys, created by the console's owner or a super admin." : undefined,
      });
    }
    throw new UnifiError("offline", `No console running ${app} is online right now (${installed.map(describe).join("; ")}).`, {
      hint: "Check that the console is powered on with Remote Access enabled.",
    });
  }
  throw new UnifiError("config", `This key can see ${usable.length} online consoles running ${app}, so I won't guess: ${usable.map(describe).join("; ")}.`, {
    hint: "Pass console_id (an ID or a console name), or set UNIFI_CONSOLE_ID in the plugin settings.",
  });
}

/**
 * Resolve a user-supplied console selector (ID, name or hostname, case-insensitive).
 * Duplicate names are narrowed to the online console that runs `app`.
 */
export function matchConsole(consoles: ConsoleSummary[], selector: string, app: string): ConsoleSummary {
  const sel = selector.trim();
  const byId = consoles.find((c) => c.id === sel);
  if (byId) return byId;
  const lower = sel.toLowerCase();
  const exact = consoles.filter((c) => c.name.toLowerCase() === lower || c.hostname?.toLowerCase() === lower);
  const partial = exact.length ? exact : consoles.filter((c) => c.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const usable = usableFor(partial, app);
    if (usable.length === 1) return usable[0];
    throw new UnifiError("config", `"${sel}" matches ${partial.length} consoles: ${partial.map(describe).join("; ")}.`, {
      hint: "Pass the console_id instead.",
    });
  }
  throw new UnifiError("not_found", `No console named "${sel}".`, {
    hint: consoles.length ? `Consoles: ${consoles.map((c) => c.name).join(", ")}.` : "This key can't see any consoles.",
  });
}
