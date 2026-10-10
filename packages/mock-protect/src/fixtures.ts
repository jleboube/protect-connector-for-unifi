/** Fixture data shaped like Protect API 7.2.105 responses (trimmed to relevant fields). */
export const CAMERA_FRONT = "66d025b301ebc903e80003ea";
export const CAMERA_DRIVEWAY = "672094f900e26303e800062a";
export const CAMERA_GARAGE = "6720950a00e26303e800063b";

export const cameras = [
  {
    id: CAMERA_FRONT,
    modelKey: "camera",
    state: "CONNECTED",
    name: "Front Door",
    type: "UVC G4 Doorbell Pro",
    mac: "AABBCCDDEE01",
    isMicEnabled: true,
    micVolume: 80,
    videoMode: "default",
    hdrType: "auto",
    activePatrolSlot: null,
    hasPackageCamera: true,
    ledSettings: { isEnabled: true, welcomeLed: true, floodLed: false },
    lcdMessage: { type: "LEAVE_PACKAGE_AT_DOOR", resetAt: null },
    featureFlags: {
      supportFullHdSnapshot: true,
      hasHdr: true,
      hasMic: true,
      hasSpeaker: true,
      smartDetectTypes: ["person", "vehicle", "package", "animal"],
      smartDetectAudioTypes: [],
      videoModes: ["default"],
    },
    smartDetectSettings: { objectTypes: ["person", "package"], audioTypes: [] },
  },
  {
    id: CAMERA_DRIVEWAY,
    modelKey: "camera",
    state: "CONNECTED",
    name: "Driveway",
    type: "UVC G5 Bullet",
    mac: "AABBCCDDEE02",
    isMicEnabled: false,
    videoMode: "default",
    hdrType: "off",
    activePatrolSlot: null,
    hasPackageCamera: false,
    featureFlags: { supportFullHdSnapshot: false, hasHdr: false, hasMic: true, smartDetectTypes: ["person", "vehicle", "animal"] },
    smartDetectSettings: { objectTypes: ["person", "vehicle", "animal"], audioTypes: [] },
  },
  {
    id: "6720951b00e26303e800064c",
    modelKey: "camera",
    state: "CONNECTED",
    name: "Side Gate   ",
    type: "UVC G3 Flex",
    mac: "AABBCCDDEE04",
    isMicEnabled: true,
    micVolume: 100,
    videoMode: "default",
    hdrType: "off",
    activePatrolSlot: null,
    hasPackageCamera: false,
    featureFlags: { supportFullHdSnapshot: true, hasHdr: true, hasMic: true, smartDetectTypes: [], smartDetectAudioTypes: [] },
    smartDetectSettings: { objectTypes: [], audioTypes: [] },
  },
  {
    id: CAMERA_GARAGE,
    modelKey: "camera",
    state: "DISCONNECTED",
    name: "Garage",
    type: "UVC G4 Instant",
    mac: "AABBCCDDEE03",
    hasPackageCamera: false,
    featureFlags: { smartDetectTypes: ["person"] },
    smartDetectSettings: { objectTypes: [], audioTypes: [] },
  },
];

export const nvr = {
  id: "65f0c0ffee00000000000001",
  modelKey: "nvr",
  name: "Home UDM Pro",
  type: "UDMPRO",
  mac: "AABBCCDDEE00",
  doorbellSettings: { defaultMessageText: "WELCOME", defaultMessageResetTimeoutMs: 60000, customMessages: [], customImages: [] },
  armMode: {
    status: "disabled",
    armProfileId: null,
    armedAt: null,
    willBeArmedAt: null,
    breachDetectedAt: null,
    breachEventCount: 0,
    breachTriggerEventId: null,
    breachEventId: null,
  },
};

export const lights = [
  {
    id: "6720960000e26303e8000700",
    modelKey: "light",
    state: "CONNECTED",
    name: "Backyard Flood",
    type: "UP FloodLight",
    mac: "AABBCCDDEE10",
    lightModeSettings: { mode: "motion", enableAt: "dark" },
    lightDeviceSettings: { isIndicatorEnabled: true, pirDuration: 30000, pirSensitivity: 50, ledLevel: 4 },
    isDark: true,
    isLightOn: false,
    isLightForceEnabled: false,
    lastMotion: 1760040000000,
    isPirMotionDetected: false,
    camera: CAMERA_DRIVEWAY,
  },
];

export const chimes = [
  {
    id: "6720970000e26303e8000800",
    modelKey: "chime",
    state: "CONNECTED",
    name: "Hallway Chime",
    type: "UP Chime",
    mac: "AABBCCDDEE20",
    cameraIds: [CAMERA_FRONT],
    ringSettings: [{ cameraId: CAMERA_FRONT, repeatTimes: 1, ringtoneId: "default", volume: 80 }],
  },
];

export const sensors = [
  {
    id: "6720980000e26303e8000900",
    modelKey: "sensor",
    state: "CONNECTED",
    name: "Back Door",
    type: "UP Sense",
    mac: "AABBCCDDEE30",
    mountType: "door",
    batteryStatus: { percentage: 15, isLow: true },
    stats: { temperature: { value: 21.5, status: "neutral" }, humidity: { value: 40, status: "neutral" }, light: { value: 12, status: "neutral" } },
    isOpened: true,
    isMotionDetected: false,
    leakDetectedAt: null,
    tamperingDetectedAt: null,
    alarmTriggeredAt: null,
  },
];

export const viewers = [
  {
    id: "6720990000e26303e8000a00",
    modelKey: "viewer",
    state: "CONNECTED",
    name: "Kitchen Viewport",
    type: "UP Viewport",
    mac: "AABBCCDDEE40",
    liveview: "672099aa00e26303e8000a10",
    streamLimit: 4,
  },
];

/** Existing RTSPS streams keyed by camera id (only Front Door has any). */
export const rtspsStreams: Record<string, Record<string, string | null>> = {
  [CAMERA_FRONT]: {
    high: "rtsps://192.168.1.1:7441/5nPr7RCmueGTKMP7?enableSrtp",
    medium: null,
    low: null,
    package: "rtsps://192.168.1.1:7441/PkG9aBcDeFgHiJkL?enableSrtp",
  },
};

export const CONSOLE_ID_HOME = "70A7419783ED0000000006797F060000000006C719490000000062ABD4EA:1261206302";
export const CONSOLE_ID_CABIN = "900A6F00301100000000074A6BA90000000007A3387E0000000063EC9853:123456789";

const ALL_APPS = ["network", "protect", "access", "talk", "connect", "innerspace"];
const ctrl = (name: string, version: string | null, installed: boolean) => ({
  name,
  version: installed ? version : null,
  state: installed ? "active" : "inactive",
  isInstalled: installed,
  isRunning: installed,
  status: installed ? "ok" : "offline",
});
const fleetHost = (id: string, name: string, hostname: string, hw: string, state: string, controllers: ReturnType<typeof ctrl>[], supported = ALL_APPS) => ({
  id,
  hardwareId: "00000000-0000-0000-0000-000000000000",
  type: "console",
  ipAddress: "198.51.100.1",
  owner: true,
  isBlocked: false,
  // Real hosts list every *supported* app here, installed or not.
  userData: { controllers: supported },
  reportedState: { name, hostname, state, version: "5.1.132", hardware: { name: hw }, controllers },
});

/** Sanitized copy of a real 6-console account (shapes from a live Site Manager response, Oct 2026). */
export const FLEET = {
  oldCloudKey: "AAAA000000000000000000000000000000000000000000000000000000000001:1000000001",
  oldUdmPro: "AAAA000000000000000000000000000000000000000000000000000000000002:1000000002",
  udmPro: "AAAA000000000000000000000000000000000000000000000000000000000003:1000000003",
  express: "AAAA000000000000000000000000000000000000000000000000000000000004:1000000004",
  udmSe: "AAAA000000000000000000000000000000000000000000000000000000000005:1000000005",
  nas: "AAAA000000000000000000000000000000000000000000000000000000000006:1000000006",
};

export function fleetHosts() {
  const off = () => ["access", "talk", "connect", "innerspace"].map((a) => ctrl(a, null, false));
  return [
    fleetHost(FLEET.oldCloudKey, "CloudKey+", "CloudKey", "UniFi Cloudkey Plus", "disconnected", [ctrl("network", "8.5.6", true), ctrl("protect", "5.0.47", true), ...off()]),
    fleetHost(FLEET.oldUdmPro, "Dream Machine Pro", "Dream-Machine-Pro", "UniFi Dream Machine Pro", "disconnected", [ctrl("network", "8.0.24", true), ctrl("protect", "2.10.10", true), ...off()]),
    fleetHost(FLEET.udmPro, "Dream Machine Pro", "Dream-Machine-Pro", "UniFi Dream Machine Pro", "connected", [ctrl("network", "10.6.106", true), ctrl("protect", "7.2.105", true), ...off()]),
    fleetHost(FLEET.express, "Express 7", "Express-7", "UniFi Express 7", "connected", [ctrl("network", "10.6.106", true)], ["network"]),
    fleetHost(FLEET.udmSe, "Branch Dream Machine SE", "Branch-Dream-Machine-SE", "UniFi Dream Machine SE", "connected", [ctrl("network", "10.6.106", true), ctrl("protect", "7.2.105", true), ctrl("access", "4.3.12", true), ctrl("talk", "5.3.2", true), ctrl("connect", null, false), ctrl("innerspace", null, false)]),
    fleetHost(FLEET.nas, "UNAS Pro", "UNAS-Pro", "UniFi Network Attached Storage Pro", "connected", [ctrl("drive", "4.4.9", true)], ["drive"]),
  ];
}

export function hosts(which: "one" | "two") {
  const home = {
    id: CONSOLE_ID_HOME,
    hardwareId: "e5bf13cd-98a7-5a96-9463-0d65d78cd3a4",
    type: "console",
    ipAddress: "203.0.113.10",
    owner: true,
    isBlocked: false,
    userData: { controllers: ["network", "protect"] },
    reportedState: {
      name: "Home UDM Pro",
      hostname: "udm-pro",
      state: "connected",
      version: "4.3.6",
      hardware: { name: "UniFi Dream Machine Pro", shortname: "UDMPRO" },
      controllers: [
        { name: "network", version: "9.4.19", state: "active", isInstalled: true },
        { name: "protect", version: "7.2.105", state: "active", isInstalled: true },
      ],
    },
  };
  const cabin = {
    id: CONSOLE_ID_CABIN,
    hardwareId: "a1b2c3d4-0000-0000-0000-000000000000",
    type: "console",
    ipAddress: "203.0.113.20",
    owner: true,
    isBlocked: false,
    userData: { controllers: ["network", "protect"] },
    reportedState: {
      name: "Cabin UCG",
      state: "connected",
      version: "4.3.6",
      hardware: { name: "UniFi Cloud Gateway Ultra" },
      controllers: [{ name: "protect", version: "7.1.83", isInstalled: true }],
    },
  };
  return which === "one" ? [home] : [home, cabin];
}
