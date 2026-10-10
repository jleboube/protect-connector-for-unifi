/**
 * Every Protect Integration API endpoint this connector calls. All are GET.
 * Each was checked against Ubiquiti's published OpenAPI specs:
 *   https://developer.ui.com/protect/v7.2.105/openapi.json  (Joe's console: Protect 7.2.105)
 *   https://developer.ui.com/protect/v7.3.70/openapi.json   (latest at build time)
 * The path sets of 7.2.105 and 7.3.70 are identical, so nothing here is newer
 * than 7.2. Older Protect releases may lack some paths; they return 404, which
 * the client maps to a friendly "not found / not on this version" message.
 */
export const PROTECT_SPEC_VERSION = "7.3.70";
export const PROTECT_MIN_TESTED_SPEC = "7.2.105";

export const ENDPOINTS = {
  metaInfo: "/v1/meta/info",
  cameras: "/v1/cameras",
  camera: (id: string) => `/v1/cameras/${id}`,
  snapshot: (id: string) => `/v1/cameras/${id}/snapshot`,
  rtspsStreams: (id: string) => `/v1/cameras/${id}/rtsps-stream`, // GET only (existing streams)
  nvrs: "/v1/nvrs",
  lights: "/v1/lights",
  light: (id: string) => `/v1/lights/${id}`,
  chimes: "/v1/chimes",
  chime: (id: string) => `/v1/chimes/${id}`,
  sensors: "/v1/sensors",
  sensor: (id: string) => `/v1/sensors/${id}`,
  viewers: "/v1/viewers",
  viewer: (id: string) => `/v1/viewers/${id}`,
} as const;
