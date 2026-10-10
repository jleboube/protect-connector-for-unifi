---
name: unifi-protect
description: Check UniFi Protect cameras, snapshots, sensors, floodlights, chimes and viewers through the read-only Protect Connector for UniFi. Use when the user asks what a camera sees, whether cameras are online, or about door/window sensors.
---

# Using Protect Connector for UniFi (community)

1. Start with `protect_list_cameras` to get names, states and ids. Camera tools accept a name ("Front Door") or an id.
2. For "what's happening at X", call `protect_get_snapshot` and describe the image. Use `channel: "package"` on doorbells that list a package camera.
3. `protect_get_info` confirms the connection and shows the Protect version.
4. If a tool says several consoles are visible, run `unifi_list_consoles` and pass `console_id`.
5. `protect_get_stream_urls` returns secrets. Keep URLs masked unless the user explicitly asks for the full URL, and never paste them anywhere else.
6. The connector is read-only. It can't arm/disarm, move PTZ cameras, trigger alarms or create streams; tell the user to do that in the Protect app.
7. Event history isn't available through Ubiquiti's API (events are only pushed live over a WebSocket), so don't promise "what happened yesterday".
