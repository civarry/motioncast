// Phone controller: reads motion/orientation sensors and streams them to the
// laptop over WebSocket. Also vibrates on command from the laptop.

const ROOM = new URLSearchParams(location.search).get("room") || "default";

const $ = (id) => document.getElementById(id);
const wsDot = $("wsDot"), wsText = $("wsText"), laptops = $("laptops");
const permNote = $("permNote");

let ws, sending = false;
let latest = { type: "sensor", room: ROOM };

// ---------- WebSocket ----------
function connect() {
  ws = new WebSocket(`wss://${location.host}`);
  ws.onopen = () => {
    wsDot.classList.add("on");
    wsText.textContent = "connected";
    ws.send(JSON.stringify({ type: "hello", role: "phone", room: ROOM }));
  };
  ws.onclose = () => {
    wsDot.classList.remove("on");
    wsText.textContent = "reconnecting…";
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "peers") laptops.textContent = m.laptops;
    if (m.type === "haptic") buzz(m.pattern || 40);
  };
}
connect();

// Stream the latest sensor frame at ~30 Hz (coalesced, not per-event).
setInterval(() => {
  if (sending && ws && ws.readyState === 1) ws.send(JSON.stringify(latest));
}, 33);

// ---------- Haptics ----------
function buzz(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}
$("buzzBtn").addEventListener("click", () => buzz([20, 60, 20]));
document.querySelectorAll("[data-buzz]").forEach((b) =>
  b.addEventListener("click", () =>
    buzz(b.dataset.buzz.split(",").map(Number))
  )
);

// ---------- Sensors ----------
function onOrientation(e) {
  latest.alpha = e.alpha; latest.beta = e.beta; latest.gamma = e.gamma;
  $("alpha").textContent = fmt(e.alpha);
  $("beta").textContent = fmt(e.beta);
  $("gamma").textContent = fmt(e.gamma);
}
function onMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration || {};
  latest.ax = a.x; latest.ay = a.y; latest.az = a.z;
  const r = e.rotationRate || {};
  latest.rrAlpha = r.alpha; latest.rrBeta = r.beta; latest.rrGamma = r.gamma;
  $("ax").textContent = fmt(a.x);
  $("ay").textContent = fmt(a.y);
  $("az").textContent = fmt(a.z);
}
const fmt = (n) => (n == null ? "–" : n.toFixed(1));

// True orientation quaternion straight from sensor fusion. Euler alpha/beta/
// gamma go ambiguous when the phone is upright (gimbal lock — yaw and roll
// become indistinguishable). The Generic Sensor API quaternion has no such
// blind spot, so we stream it for the live 3D model when the phone supports it.
let orientationSensor = null;
function startOrientationSensor() {
  const Sensor = window.RelativeOrientationSensor;
  if (!Sensor) return; // older phones: laptop falls back to Euler reconstruction
  try {
    orientationSensor = new Sensor({ frequency: 60, referenceFrame: "device" });
    orientationSensor.addEventListener("reading", () => {
      const q = orientationSensor.quaternion; // [x, y, z, w]
      if (q) { latest.qx = q[0]; latest.qy = q[1]; latest.qz = q[2]; latest.qw = q[3]; }
    });
    orientationSensor.addEventListener("error", () => { orientationSensor = null; });
    orientationSensor.start();
  } catch {
    orientationSensor = null; // permission/hardware issue → Euler fallback
  }
}

async function start() {
  try {
    // iOS 13+ needs an explicit permission request from a user gesture.
    if (typeof DeviceOrientationEvent?.requestPermission === "function") {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== "granted") throw new Error("orientation denied");
    }
    if (typeof DeviceMotionEvent?.requestPermission === "function") {
      await DeviceMotionEvent.requestPermission();
    }
    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
    startOrientationSensor();
    sending = true;
    buzz(20);
    $("startBtn").textContent = "Streaming ✓";
    $("startBtn").disabled = true;
    permNote.textContent = "Move and tilt your phone — the laptop is listening.";
  } catch (err) {
    permNote.textContent =
      "Could not access sensors: " + err.message +
      ". Make sure you opened this page over HTTPS.";
  }
}
$("startBtn").addEventListener("click", start);

// Register service worker so this is installable as a PWA.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
