# Contributing

Thanks for your interest! This is a small, dependency-light project — the goal
is to keep it easy to read, hack on, and learn from.

## Getting started

```bash
git clone <your-fork-url>
cd motioncast
npm install
npm start
```

Then:
1. **Laptop:** open `https://localhost:8443/laptop` (accept the self-signed cert).
2. **Phone** (same Wi-Fi): open the `https://<lan-ip>:8443/` URL the start command
   prints, tap **Start sensors**, and tilt.

You need a real phone to test sensors — desktop browsers don't emit motion data.
Android/Chrome exercises the Generic Sensor (quaternion) path; iOS/Safari
exercises the Euler `deviceorientation` fallback. Testing on both is ideal,
since they use different axis conventions.

## Project layout

| Path | What it is |
|------|------------|
| `server.js` | HTTPS static host + WebSocket relay (rooms). |
| `public/index.html` + `sensors.js` | The phone controller (PWA). |
| `public/laptop.html` + `game.js` | Laptop receiver, 3D model, calibration UI, Tilt Arena. |
| `public/style.css` | Dark neon theme + 3D model styles. |
| `public/manifest.webmanifest`, `sw.js`, `icon*.svg` | PWA install assets. |
| `docs/PROTOCOL.md` | WebSocket message reference. |

## Guidelines

- **No build step, no framework.** Plain ES modules + vanilla DOM. Keep it that
  way unless there's a strong reason not to.
- **Keep dependencies minimal.** The runtime deps are just `express`,
  `selfsigned`, and `ws`.
- **Match the surrounding style** — comments explain the *why* (especially the
  orientation math), naming is descriptive, no clever one-liners that hide intent.
- **Orientation changes:** if you touch the quaternion ↔ screen mapping, test
  pitch, yaw, and roll independently on **both** a quaternion device and a Euler
  device. The two conventions are handled by per-source profiles in `game.js`.
- **Commits:** clear, imperative subject lines. Squash noise before opening a PR.

## Ideas to pick up

See the **Ideas & roadmap** section in the [README](README.md). Air-mouse,
presentation remote, gesture recognition, multiplayer, and a recording/playback
tool are all good first projects on top of the sensor stream.

## Reporting issues

Include: device + OS + browser, whether the debug panel shows
`quaternion` or `euler`, and what you expected vs. saw. A screenshot of the
**Advanced** panel's live values helps a lot.
