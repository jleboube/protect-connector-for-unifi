import { UnifiError } from "./errors.js";

export type ConnectionMode = "local" | "cloud";
/** UniFi applications that expose an Integration API behind /proxy/<app>/integration. */
export type UnifiApp = "protect" | "network";

export const DEFAULT_CLOUD_BASE_URL = "https://api.ui.com";

/** Console IDs look like "<hex>:<digits>". Keep validation loose but path-safe. */
const CONSOLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
/** Protect/Network object IDs are hex-ish strings; never allow path separators. */
const OBJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function assertConsoleId(id: string): string {
  if (!CONSOLE_ID_RE.test(id)) {
    throw new UnifiError("config", `"${truncate(id)}" doesn't look like a UniFi console ID.`, {
      hint: "Console IDs look like 900A6F00…:123456789. Run unifi_list_consoles to find yours.",
    });
  }
  return id;
}

export function assertObjectId(id: string, label = "ID"): string {
  if (!OBJECT_ID_RE.test(id)) {
    throw new UnifiError("config", `"${truncate(id)}" isn't a valid ${label}.`, {
      hint: "Use the id value returned by the matching list tool.",
    });
  }
  return id;
}

/**
 * Normalise the local console address. Accepts "192.168.1.1", "udm.lan:8443"
 * or a full "https://..." URL (http:// is accepted for test servers only).
 */
export function normaliseLocalBase(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (!h) throw new UnifiError("config", "No console host configured for local mode.");
  if (/^https?:\/\//i.test(h)) return h;
  if (/[\s/?#@]/.test(h)) throw new UnifiError("config", `"${truncate(h)}" isn't a valid host name or IP.`);
  return `https://${h}`;
}

export interface RouteConfig {
  mode: ConnectionMode;
  /** local mode: console host or URL */
  host?: string;
  /** cloud mode: Site Manager console (host) id */
  consoleId?: string;
  /** cloud mode: defaults to https://api.ui.com */
  cloudBaseUrl?: string;
}

/**
 * Build the full URL for an Integration API path.
 *   local: https://<host>/proxy/<app>/integration<path>
 *   cloud: https://api.ui.com/v1/connector/consoles/<consoleId>/proxy/<app>/integration<path>
 * `path` must start with "/v1/".
 */
export function appUrl(cfg: RouteConfig, app: UnifiApp, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!path.startsWith("/v1/")) throw new Error(`Integration path must start with /v1/: ${path}`);
  let base: string;
  if (cfg.mode === "local") {
    base = `${normaliseLocalBase(cfg.host ?? "")}/proxy/${app}/integration`;
  } else {
    if (!cfg.consoleId) throw new UnifiError("config", "No console selected for cloud mode.", {
      hint: "Pass console_id, set UNIFI_CONSOLE_ID, or run unifi_list_consoles.",
    });
    const cloud = (cfg.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, "");
    base = `${cloud}/v1/connector/consoles/${assertConsoleId(cfg.consoleId)}/proxy/${app}/integration`;
  }
  return base + path + toQuery(query);
}

/** Site Manager API URL (cloud only), e.g. siteManagerUrl(cfg, "/v1/hosts"). */
export function siteManagerUrl(cloudBaseUrl: string | undefined, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const cloud = (cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, "");
  return cloud + path + toQuery(query);
}

function toQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
