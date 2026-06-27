# 📱→🖥️ Phone Sensor Controller

Turn any phone into a real-time **motion + haptics controller** for your laptop —
no app store, no native build. Open a web page on your phone, and its
**orientation**, **accelerometer**, and **vibration** stream to your laptop over
a local HTTPS + WebSocket link. Installable as a **PWA** on Android.

It ships with a live **3D phone model** that mirrors your device's real
orientation, a guided calibration flow, and a demo game — **Tilt Arena** — where
you roll a ball across a 3D-tilting board by leaning the phone, and the phone
buzzes when you grab a target.

> Built as a "what can a phone's sensors drive on a laptop?" experiment. There's
> a lot more you can build on top of it — see [Ideas](#-ideas--roadmap).

---

## ✨ Features

- **Live 3D orientation** — a CSS-3D phone model tracks the device's real pose.
- **Gimbal-lock-free** — uses the Generic Sensor API quaternion when available
  (Android/Chrome), with a Euler `deviceorientation` fallback (iOS/Safari).
- **Per-device calibration profiles** — the two sensor APIs use different axis
  conventions, so the laptop auto-detects the source and applies a matching
  profile (axis mapping + inverts + trims). Settings persist per device type.
- **Guided setup + fine-tuning** — a step-by-step calibration wizard, per-axis
  invert toggles, a "swap roll ↔ yaw" fix, and live trim sliders.
- **Export / import settings** — snapshot a known-good config to JSON and reload it.
- **Haptics, both ways** — the laptop can buzz the phone; the game buzzes on pickup.
- **PWA** — installable, offline-capable shell, works over your LAN.

## 🚀 Quick start

```bash
npm install
npm start
```

Then:
1. **Laptop:** open `https://localhost:8443/laptop` (accept the self-signed cert warning).
2. **Phone** (same Wi-Fi): open `https://<your-lan-ip>:8443/` — the start command
   prints the exact URL. Accept the cert warning, tap **Start sensors**, and tilt.
   On Android you can also **Install** it from the browser menu.

Pair multiple devices on the same channel by adding `?room=myroom` to both URLs.

### Why HTTPS?
Browser motion sensors (`DeviceMotion` / `DeviceOrientation` / Generic Sensor API)
only work in a **secure context**. A laptop LAN IP over plain `http://` is not
secure, so the server runs HTTPS with a self-signed cert that's generated
automatically into `.cert/` on first run.

## 🧭 Calibration & tuning

- **Calibrate front** — hold the phone the way you want "straight ahead," then tap it.
- **Guided setup** — walks you through pitch (nod), yaw (door hinge), and roll
  (spin), confirming each axis matches with ✓ / ✗.
- **Swap roll ↔ yaw** — one-tap fix if a device has those two axes crossed.
- **Trim sliders** — small per-axis degree offsets for minor misalignment.
- **Export / Import** — under *Advanced*, save/restore the full profile set.
  A `known-good-settings.json` baseline (iPhone + Android) is included.

## 🏗️ How it works

```
 Phone (PWA)                    Server (Node)                 Laptop (browser)
 ─────────────                  ─────────────                 ────────────────
 sensors.js  ──sensor frames──▶  server.js  ──relay (room)──▶  game.js
   • Generic Sensor quaternion    • HTTPS static host          • 3D model (CSS matrix3d)
   • deviceorientation fallback   • WebSocket relay            • calibration profiles
   • navigator.vibrate      ◀──haptic commands───────────────  • Tilt Arena game
```

- **Transport:** an Express HTTPS server serves the static PWA and runs a
  `ws` WebSocket relay. Clients join a *room*; phones broadcast sensor frames to
  laptops, laptops send haptic commands back to phones.
- **Orientation math:** device orientation is handled as **quaternions** to avoid
  gimbal lock. Calibration is a relative rotation (`conj(ref) · live`), smoothed
  with normalized lerp, and rendered via a `matrix3d` CSS transform. The
  device→screen mapping handles CSS's Y-down axis and the yaw/roll convention
  difference between sensor APIs.

## 📁 Project structure

```
server.js                     HTTPS static host + WebSocket relay
public/
  index.html + sensors.js     phone controller (the PWA)
  laptop.html + game.js       laptop receiver + Tilt Arena + calibration UI
  style.css                   dark neon theme + 3D model styles
  manifest.webmanifest, sw.js, icon*.svg   PWA install assets
known-good-settings.json      importable iPhone + Android calibration baseline
```

## 💡 Ideas & roadmap

This is a foundation — a lot can be built on the sensor stream:

- Map yaw/pitch to **mouse / cursor** or media keys via a native helper.
- **Air-mouse / presentation remote** (point + click + gesture to advance slides).
- **Motion gestures** from `rotationRate` / acceleration (flick, shake, chop).
- **Two-phone multiplayer** in the same room; more games.
- **Recording & playback** of sensor sessions for analysis.
- **VR/AR-style head or controller tracking** in the browser.
- A small **WebSocket API doc** so other clients can consume the stream.

PRs and ideas welcome.

## 🤝 Contributing

1. Fork and clone.
2. `npm install && npm start`.
3. Open `https://localhost:8443/laptop` and pair a phone on the same Wi-Fi.
4. Send a PR. Keep it dependency-light and framework-free where possible.

## 📜 License

[MIT](LICENSE) © civarry
