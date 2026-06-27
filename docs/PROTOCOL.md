# WebSocket Protocol

The server (`server.js`) is a thin **relay**. Clients connect over
`wss://<host>` and join a **room**; the server forwards messages between the
phones and laptops in that room. There is no central state beyond room
membership - every message is a single JSON object with a `type` field.

This doc is enough to write your own client (a custom controller, a different
receiver, a logger, a native bridge, etc.).

## Connection

```js
const ws = new WebSocket(`wss://${location.host}`);
```

Sensors require a **secure context**, so this must be `wss://` (HTTPS). The
default port is `8443`.

## Roles & rooms

- **role** - `"phone"` (a sensor source) or `"laptop"` (a receiver). Anything
  other than `"laptop"` is treated as `"phone"`.
- **room** - a string channel (max 32 chars). Clients only exchange messages
  with others in the same room. Defaults to `"default"`; pick one with
  `?room=myroom` in the page URL.

Sensor frames flow **phone → laptops**. Haptic commands flow **laptop → phones**.

## Messages

### `hello` - client → server (required first message)
Registers the connection's role and room. Send this immediately on open.

```json
{ "type": "hello", "role": "phone", "room": "default" }
```

### `sensor` - phone → laptops
Coalesced sensor frame, sent ~30 Hz. All sensor fields are optional - only what
the device exposes is present.

```json
{
  "type": "sensor",
  "room": "default",

  "alpha": 17.4, "beta": 62.1, "gamma": -3.8,        // deviceorientation (deg)
  "qx": 0.12, "qy": 0.01, "qz": -0.34, "qw": 0.93,   // Generic Sensor quaternion
  "ax": 0.02, "ay": -0.11, "az": 9.79,               // acceleration incl. gravity (m/s²)
  "rrAlpha": 1.3, "rrBeta": -0.4, "rrGamma": 0.0     // rotationRate (deg/s)
}
```

- **Prefer the quaternion** (`qx,qy,qz,qw`) when present - it's gimbal-lock free.
  Fall back to Euler `alpha/beta/gamma` otherwise. Note the two sources use
  different axis conventions (yaw/roll are swapped between them).
- The server forwards `sensor` messages only from `phone` clients, only to
  `laptop` clients in the same room.

### `haptic` - laptop → phones
Asks phones in the room to vibrate. `pattern` is anything
[`navigator.vibrate`](https://developer.mozilla.org/docs/Web/API/Navigator/vibrate)
accepts: a single duration (ms) or an on/off array.

```json
{ "type": "haptic", "room": "default", "pattern": [20, 50, 20] }
```

The server forwards `haptic` messages only from `laptop` clients, only to
`phone` clients in the same room.

### `calibrate` - phone → laptops
Asks the laptop(s) to treat the phone's **current pose** as "straight ahead"
(the orientation reference). Lets you calibrate from the phone in hand without
reaching for the laptop.

```json
{ "type": "calibrate", "room": "default" }
```

Forwarded only from `phone` clients to `laptop` clients in the same room.

### `ping` / `pong` - latency probe
The laptop sends `ping` with its own clock in `t`; phones echo it straight back
as `pong` with the same `t`. The laptop computes round-trip from `t` without any
clock synchronisation (one-way ≈ round-trip ÷ 2).

```json
{ "type": "ping", "room": "default", "t": 12345.6 }   // laptop → phones
{ "type": "pong", "room": "default", "t": 12345.6 }   // phone  → laptops
```

### `peers` - server → all clients in a room
Broadcast whenever room membership changes (someone joins/leaves).

```json
{ "type": "peers", "phones": 1, "laptops": 1 }
```

## HTTP endpoints

Besides the static files and the WebSocket, the server exposes two small helpers
the laptop page uses to onboard phones:

- `GET /api/info` → `{ "ip": "192.168.x.x", "port": 8443 }` - the LAN address a
  phone can actually reach (the laptop page may be open on `localhost`).
- `GET /api/qr?text=<url>` → an SVG QR code for the given short string, generated
  locally (nothing leaves the machine). Used to render the "scan to connect" code.

## Notes

- Unknown message types are ignored. Malformed JSON is dropped silently.
- There's no auth - it's meant for your own LAN. Don't expose it to the public
  internet as-is.
- The relay is symmetric and stateless per-message, so adding new message types
  (e.g. a `chat` or `command` channel) is mostly a matter of teaching
  `server.js` who is allowed to send/receive them.
