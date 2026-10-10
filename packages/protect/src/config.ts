import { UnifiError, type ConnectionMode } from "@unifi-mcp/core";

export interface EnvConfig {
  apiKey: string;
  mode: ConnectionMode;
  host?: string;
  consoleId?: string;
  verifyTls: boolean;
  cloudBaseUrl?: string;
}

/** Treat empty strings and unsubstituted "${VAR}" placeholders as unset. */
export function cleanValue(v: string | null | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = v.trim();
  if (!t || /^\$\{[^}]*\}$/.test(t)) return undefined;
  return t;
}

/**
 * Read stdio configuration from environment variables.
 *   UNIFI_API_KEY      required. Console integration key (local) or Site Manager key (cloud).
 *   UNIFI_HOST         console IP/hostname → local mode (LAN).
 *   UNIFI_CONSOLE_ID   optional console for cloud mode (else auto-detected).
 *   UNIFI_MODE         optional override: "local" or "cloud".
 *   UNIFI_VERIFY_TLS   local mode only; default false because consoles ship self-signed certs.
 */
export function configFromEnv(env: Record<string, string | undefined>): EnvConfig {
  const apiKey = cleanValue(env.UNIFI_API_KEY);
  if (!apiKey) {
    throw new UnifiError("config", "UNIFI_API_KEY is not set.", {
      hint: "Use a Site Manager key (unifi.ui.com → Settings → API Keys) for cloud mode, or a console key (console Settings → Control Plane → Integrations) with UNIFI_HOST for local mode.",
    });
  }
  const host = cleanValue(env.UNIFI_HOST);
  const consoleId = cleanValue(env.UNIFI_CONSOLE_ID);
  const modeRaw = cleanValue(env.UNIFI_MODE)?.toLowerCase();
  if (modeRaw && modeRaw !== "local" && modeRaw !== "cloud") {
    throw new UnifiError("config", `UNIFI_MODE must be "local" or "cloud", not "${modeRaw}".`);
  }
  const mode: ConnectionMode = (modeRaw as ConnectionMode | undefined) ?? (host ? "local" : "cloud");
  if (mode === "local" && !host) throw new UnifiError("config", "Local mode needs UNIFI_HOST (the console's IP or hostname).");
  const verifyRaw = cleanValue(env.UNIFI_VERIFY_TLS)?.toLowerCase();
  const verifyTls = mode === "cloud" ? true : verifyRaw === "true" || verifyRaw === "1";
  return { apiKey, mode, host, consoleId, verifyTls, cloudBaseUrl: cleanValue(env.UNIFI_CLOUD_BASE_URL) };
}
