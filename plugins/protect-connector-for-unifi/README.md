# Protect Connector for UniFi (community)

**Read-only access to your UniFi Protect cameras from your AI assistant.**

Ask things like "Is anyone at the front door?", "Which cameras are offline?", or "Is the back door sensor open?" The connector lists your cameras and their status, grabs live snapshots you can look at in chat, and reads your sensors, floodlights, chimes and Viewports.

> Community project. Not affiliated with, endorsed by, or sponsored by Ubiquiti Inc. "UniFi" and "UniFi Protect" are trademarks of Ubiquiti Inc., used here only to describe what this connector works with.

## What it can do

| Tool | What it does |
|---|---|
| `unifi_list_consoles` | Lists the consoles your key can see, with console IDs |
| `protect_get_info` | Protect version, NVR name/model, alarm arm state |
| `protect_list_cameras` | Every camera with online state, model and enabled smart detections |
| `protect_get_camera` | One camera's details (by name or id) |
| `protect_get_snapshot` | A live JPEG from a camera, returned as an image (main or package channel) |
| `protect_get_nvr` | NVR details |
| `protect_list_lights` / `_chimes` / `_sensors` / `_viewers` | Device status lists |
| `protect_get_device` | One light, chime, sensor or viewer |
| `protect_get_stream_urls` | **Sensitive.** Existing RTSPS URLs, masked unless you ask for them |

It **cannot change anything**: no arming, PTZ, sirens, alarms, settings or stream creation. There is no write code in this version at all.

## Setup

1. Make sure **Remote Access** is turned on for your console (UniFi OS → Settings → Remote Access).
2. Go to [unifi.ui.com](https://unifi.ui.com) → **Settings → API Keys** → **Create New API Key**. Copy it (it's shown once). Use an account that owns or super-administers the console.
3. Install the plugin and paste the key into **UNIFI_API_KEY**.
4. Optional: if your key can see several consoles running Protect, set **UNIFI_CONSOLE_ID** to the console ID or name (ask the assistant to run `unifi_list_consoles`). Offline consoles and Protect versions older than 5.3 are ignored when auto-picking.

## Privacy and security

- The connector runs at `https://unifi-mcp.ai-sherpa.rocks/mcp` (a Cloudflare Worker). Your key travels in a request header, is used to call Ubiquiti's official API at `api.ui.com` for that request, and is then discarded. It is **never stored or logged**, and request logging is turned off.
- Calls go through Ubiquiti's Site Manager cloud connector, which allows 100 requests per minute per console.
- Snapshots and device data pass through the Worker to your assistant and are not kept.
- Stream URLs grant live video access without a password, so they're masked by default.
- Source code: https://github.com/jleboube/protect-connector-for-unifi (MIT).

## Limits

- Event history (e.g. "who came by yesterday") isn't offered by Ubiquiti's API; live events are WebSocket-only and don't work through the cloud connector.
- Built and tested against Protect API 7.2.105 and 7.3.70. Older Protect versions may lack some endpoints; those tools return a clear "not available" message.
