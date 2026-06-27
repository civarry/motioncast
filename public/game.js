// Laptop receiver: listens for phone sensor frames, drives a tilt-controlled
// ball game, visualizes orientation, and sends haptic commands back.

const ROOM = new URLSearchParams(location.search).get("room") || "default";
const $ = (id) => document.getElementById(id);

const wsDot = $("wsDot"), wsText = $("wsText"), phones = $("phones");

// Build the phone-facing URL from the server's LAN address and render a QR for
// it, so a phone can join by scanning instead of typing an IP.
fetch("/api/info")
  .then((r) => r.json())
  .then(({ ip, port }) => {
    const url = `https://${ip}:${port}/` + (ROOM !== "default" ? `?room=${encodeURIComponent(ROOM)}` : "");
    $("phoneUrl").textContent = url;
    const img = $("qrImg");
    if (img) img.src = "/api/qr?text=" + encodeURIComponent(url);
  })
  .catch(() => {
    $("phoneUrl").textContent = `https://${location.hostname}:${location.port}/`;
  });

let ws;
let tilt = { beta: 0, gamma: 0 }; // smoothed control input
let scoreVal = 0;

// Link health: streamed frames per second + round-trip latency (ping/pong).
let frameCount = 0, latencyMs = null, pingTimer = null;

function connect() {
  ws = new WebSocket(`wss://${location.host}`);
  ws.onopen = () => {
    wsDot.classList.add("on");
    wsText.textContent = "connected";
    ws.send(JSON.stringify({ type: "hello", role: "laptop", room: ROOM }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1)
        ws.send(JSON.stringify({ type: "ping", room: ROOM, t: performance.now() }));
    }, 1000);
  };
  ws.onclose = () => {
    wsDot.classList.remove("on");
    wsText.textContent = "reconnecting…";
    clearInterval(pingTimer);
    latencyMs = null;
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "peers") {
      phones.textContent = m.phones;
      $("waiting").style.display = m.phones > 0 ? "none" : "";
      if (m.phones === 0) needZero = true; // re-zero next phone that joins
    }
    if (m.type === "sensor") { frameCount++; onSensor(m); }
    if (m.type === "calibrate") calibrateFront(true); // phone tapped "Calibrate front"
    // Round-trip carried the laptop's own clock, so halve for one-way latency.
    if (m.type === "pong") latencyMs = Math.max(0, Math.round((performance.now() - m.t) / 2));
  };
}
connect();

// Once a second, summarise link health into the header pill.
setInterval(() => {
  const hz = frameCount;
  frameCount = 0;
  const el = $("linkStat");
  if (!el) return;
  if (hz === 0) { el.textContent = "—"; latencyMs = null; }
  else el.textContent = `${hz} Hz` + (latencyMs != null ? ` · ${latencyMs} ms` : "");
}, 1000);

function sendHaptic(pattern) {
  if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({ type: "haptic", room: ROOM, pattern }));
}
document.querySelectorAll("[data-buzz]").forEach((b) =>
  b.addEventListener("click", () =>
    sendHaptic(b.dataset.buzz.split(",").map(Number))
  )
);

// ---------- Quaternion helpers (robust orientation, no gimbal weirdness) ----------
const D2R = Math.PI / 180;
const ID = { w: 1, x: 0, y: 0, z: 0 };

// ---- Per-source orientation profiles ----------------------------------------
// Android's Generic Sensor API and iOS's Euler deviceorientation use different
// axis conventions (yaw & roll are swapped between them). So each sensor source
// keeps its OWN profile — axis mapping (swap), per-axis inverts, and trims — and
// the laptop auto-switches to the matching one when a phone connects.
function defaultProfile() {
  return {
    invert: { pitch: false, roll: false, yaw: false },
    trim: { pitch: 0, roll: 0, yaw: 0 },
    swap: false, // swap which screen axis is "roll" vs "yaw"
  };
}
const profiles = { euler: defaultProfile(), quaternion: defaultProfile() };
profiles.quaternion.swap = true; // Generic Sensor differs from Euler by a yaw/roll swap

function mergeProfile(target, src) {
  if (!src) return;
  if (src.invert) Object.assign(target.invert, src.invert);
  if (src.trim) Object.assign(target.trim, src.trim);
  if (typeof src.swap === "boolean") target.swap = src.swap;
}
(function loadProfiles() {
  const saved = JSON.parse(localStorage.getItem("orient-profiles-v1") || "null");
  if (saved) {
    mergeProfile(profiles.euler, saved.euler);
    mergeProfile(profiles.quaternion, saved.quaternion);
    return;
  }
  // First run on the profiles model: carry the old single settings into Euler.
  mergeProfile(profiles.euler, {
    invert: JSON.parse(localStorage.getItem("orient-invert-v2") || "null"),
    trim: JSON.parse(localStorage.getItem("orient-trim-v1") || "null"),
  });
})();
const saveProfiles = () => localStorage.setItem("orient-profiles-v1", JSON.stringify(profiles));

let sourceKey = "euler";        // which profile is active right now
let lastSource = "—";           // human-readable sensor path for the debug panel
const prof = () => profiles[sourceKey];
// Screen-axis → quaternion-component mapping depends on the active swap.
const rollComp = () => (prof().swap ? "z" : "y");
const yawComp = () => (prof().swap ? "y" : "z");

// Device orientation Euler (alpha,beta,gamma) -> quaternion, YXZ order (spec).
function eulerToQuat(alpha, beta, gamma) {
  const x = (beta || 0) * D2R;
  const y = (alpha || 0) * D2R;
  const z = -(gamma || 0) * D2R;
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
}
const conj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });
function qmul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
// Build the corrective trim rotation from the active profile's degree offsets.
// Pitch is always the X component; roll/yaw map to Y or Z per the active swap.
function trimQuat() {
  const t = prof().trim;
  const hx = (t.pitch || 0) * D2R / 2;
  const hRoll = (t.roll || 0) * D2R / 2;
  const hYaw = (t.yaw || 0) * D2R / 2;
  const hy = prof().swap ? hYaw : hRoll; // Y component
  const hz = prof().swap ? hRoll : hYaw; // Z component
  const qx = { w: Math.cos(hx), x: Math.sin(hx), y: 0, z: 0 };
  const qy = { w: Math.cos(hy), x: 0, y: Math.sin(hy), z: 0 };
  const qz = { w: Math.cos(hz), x: 0, y: 0, z: Math.sin(hz) };
  return qmul(qmul(qx, qy), qz);
}
// Normalized lerp toward target — cheap smoothing/jitter damping.
function nlerp(a, b, t) {
  if (a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z < 0) b = { w: -b.w, x: -b.x, y: -b.y, z: -b.z };
  const q = { w: a.w + (b.w - a.w) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}
function quatToMatrix3d(q, swap) {
  const { x, y, z, w } = q;
  // Raw device-frame rotation matrix from the quaternion.
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
  // Two device→screen mappings, both keeping the nod (pitch) correct via the
  // diag(1,-1,1) CSS Y-flip; they differ only in which screen axis is yaw vs
  // roll, matching the two sensor conventions:
  let c00, c01, c02, c10, c11, c12, c20, c21, c22;
  if (swap) {
    // M = diag(1,-1,1): y-component → screen yaw, z-component → screen roll.
    c00 = r00; c01 = -r01; c02 = r02;
    c10 = -r10; c11 = r11; c12 = -r12;
    c20 = r20; c21 = -r21; c22 = r22;
  } else {
    // M = Rx(90°)·diag(1,-1,1): y-component → screen roll, z-component → screen yaw.
    c00 = r00; c01 = -r02; c02 = -r01;
    c10 = -r20; c11 = r22; c12 = r21;
    c20 = -r10; c21 = r12; c22 = r11;
  }
  // CSS matrix3d is column-major.
  return `matrix3d(${c00},${c10},${c20},0, ${c01},${c11},${c21},0, ${c02},${c12},${c22},0, 0,0,0,1)`;
}

// ---------- Incoming sensor frame ----------
const phoneModel = $("phoneModel");
let refQuat = ID;          // calibration reference pose (a snapshot of liveQuat)
let liveQuat = ID;         // current device orientation
let shownQuat = ID;        // smoothed, displayed
let needZero = true;       // snapshot the reference pose on the next valid frame

// ---- Drop / freefall state ----
// At rest |acceleration| ≈ 1g; in freefall it collapses toward 0g; on impact it
// spikes. We track it as a ratio to an auto-calibrated baseline so it works
// whether the device reports m/s² or g-units.
let gBaseline = null, gNow = 1;
let ffState = "idle", ffStart = 0, airtimeMs = 0, lastImpactG = 0;
let dropY = 0, dropV = 0, dropPhase = "rest", settleAt = 0;

function detectDrop() {
  const now = performance.now();
  if (ffState === "idle") {
    if (gNow < 0.45) { ffState = "falling"; ffStart = now; dropPhase = "fall"; dropV = 0; }
  } else { // falling
    if (gNow > 1.7) {                 // impact spike → landed
      airtimeMs = now - ffStart;
      lastImpactG = gNow;
      ffState = "idle";
      dropPhase = "settle";
      // gentle ouch vs. a real thud
      sendHaptic(gNow > 2.4 ? [50, 40, 110] : [20, 30, 20]);
    } else if (now - ffStart > 2500) { // set down gently, never slammed
      ffState = "idle";
      dropPhase = "settle";
    }
  }
  updateDropHud();
}

function updateDropHud() {
  const g = $("gMeter");
  if (!g) return;
  g.textContent = gNow.toFixed(2) + " g";
  g.classList.toggle("hot", gNow > 1.7);
  $("ffFlash").classList.toggle("on", ffState === "falling");
  if (airtimeMs) $("airtime").textContent = Math.round(airtimeMs) + " ms air";
  if (lastImpactG) $("peakG").textContent = "peak " + lastImpactG.toFixed(1) + " g";
}

// Per-frame vertical drop animation for the on-screen model (gravity + bounce).
function animateDrop() {
  const FLOOR = 60, G = 1.5, BOUNCE = 0.42;
  if (dropPhase === "fall" || dropPhase === "settle") {
    dropV += G;
    dropY += dropV;
    if (dropY >= FLOOR) {                    // hit the bed
      dropY = FLOOR;
      dropV = Math.abs(dropV) > 1.2 ? -dropV * BOUNCE : 0;
    }
    if (dropPhase === "settle" && dropY >= FLOOR && dropV === 0) {
      if (!settleAt) settleAt = performance.now();
      if (performance.now() - settleAt > 600) { dropPhase = "rest"; settleAt = 0; }
    }
  } else {                                   // rest → glide back to centre
    dropY += (0 - dropY) * 0.08;
    if (Math.abs(dropY) < 0.3) dropY = 0;
    dropV = 0;
  }
  return dropY;
}

function onSensor(m) {
  if (m.beta != null) tilt.beta = m.beta;
  if (m.gamma != null) tilt.gamma = m.gamma;
  $("beta").textContent = fmt(m.beta);
  $("gamma").textContent = fmt(m.gamma);
  $("alpha").textContent = fmt(m.alpha);

  // Prefer the phone's true orientation quaternion (gimbal-lock free). Fall
  // back to reconstructing one from Euler angles for phones that can't send it.
  let key = sourceKey;
  if (m.qw != null) {
    liveQuat = { x: m.qx, y: m.qy, z: m.qz, w: m.qw };
    lastSource = "quaternion (Generic Sensor)";
    key = "quaternion";
  } else if (m.beta != null) {
    liveQuat = eulerToQuat(m.alpha, m.beta, m.gamma);
    lastSource = "euler (deviceorientation)";
    key = "euler";
  }
  // Switch profiles (and the UI) when the connected device's sensor type changes.
  if (key !== sourceKey) {
    sourceKey = key;
    refreshControls();
  }

  // Drop / freefall detection from acceleration magnitude (auto-calibrated 1g).
  if (m.ax != null || m.ay != null || m.az != null) {
    const mag = Math.hypot(m.ax || 0, m.ay || 0, m.az || 0);
    if (gBaseline == null) gBaseline = mag || 9.81;
    if (Math.abs(mag - gBaseline) < gBaseline * 0.2) gBaseline = gBaseline * 0.98 + mag * 0.02;
    gNow = gBaseline ? mag / gBaseline : 1;
    detectDrop();
  }

  // First valid frame: treat however the phone is held now as "straight ahead."
  if (needZero && (m.qw != null || m.beta != null)) {
    refQuat = liveQuat;
    needZero = false;
    $("calNote").textContent =
      "Auto-zeroed to your current pose. Tap Calibrate front to re-center anytime.";
  }
}

// Render the phone at ~60fps independent of network frame rate.
function renderPhone() {
  const rel = qmul(conj(refQuat), liveQuat); // orientation relative to calibration
  // Per-axis direction preference: negating one component of the relative
  // quaternion flips that screen axis's sense while leaving the others intact.
  // Pitch is the X component; roll/yaw map to Y or Z per the active swap.
  const inv = prof().invert;
  if (inv.pitch) rel.x = -rel.x;
  if (inv.roll) rel[rollComp()] = -rel[rollComp()];
  if (inv.yaw) rel[yawComp()] = -rel[yawComp()];
  const tuned = qmul(rel, trimQuat()); // apply fine-tune offsets
  shownQuat = nlerp(shownQuat, tuned, 0.25);
  // Vertical drop offset (freefall → fall + bounce on the bed) wraps the rotation.
  const y = animateDrop().toFixed(1);
  phoneModel.style.transform = `translateY(${y}px) ` + quatToMatrix3d(shownQuat, prof().swap);
  requestAnimationFrame(renderPhone);
}
renderPhone();

function calibrateFront(fromPhone) {
  refQuat = liveQuat;
  needZero = false;
  $("calNote").textContent = fromPhone
    ? "Calibrated from the phone ✓ — this pose is now “straight ahead.”"
    : "Calibrated ✓ — this pose is now “straight ahead.”";
  sendHaptic([15, 40, 15]);
}
$("calibrate").addEventListener("click", () => calibrateFront(false));
$("resetCal").addEventListener("click", () => {
  refQuat = ID;
  needZero = true;
  $("calNote").textContent = "Calibration reset — re-zeroing to your current pose.";
});

// Per-axis invert toggles — operate on the active profile.
["pitch", "roll", "yaw"].forEach((axis) => {
  $("inv-" + axis).addEventListener("click", () => {
    prof().invert[axis] = !prof().invert[axis];
    saveProfiles();
    syncInvert(axis);
  });
});
const syncInvert = (axis) => $("inv-" + axis).classList.toggle("active", prof().invert[axis]);

// Swap roll ↔ yaw — corrects the axis convention for the active device profile.
$("swapAxes").addEventListener("click", () => {
  prof().swap = !prof().swap;
  saveProfiles();
  syncSwap();
});
const syncSwap = () => $("swapAxes").classList.toggle("active", prof().swap);

// ---------- Advanced: trim offsets, live debug readout, export / import ----------
// Each axis has a draggable slider + a number box; they stay mirrored.
function setTrim(axis, value) {
  const v = Math.max(-180, Math.min(180, Math.round(Number(value) || 0)));
  prof().trim[axis] = v;
  $("trim-" + axis).value = v;
  $("trimnum-" + axis).value = v;
  saveProfiles();
}
["pitch", "roll", "yaw"].forEach((axis) => {
  $("trim-" + axis).addEventListener("input", (e) => setTrim(axis, e.target.value));
  $("trimnum-" + axis).addEventListener("input", (e) => setTrim(axis, e.target.value));
});

// Reflect the active profile in every control (called on load + source switch).
function refreshControls() {
  ["pitch", "roll", "yaw"].forEach((axis) => {
    syncInvert(axis);
    $("trim-" + axis).value = prof().trim[axis];
    $("trimnum-" + axis).value = prof().trim[axis];
  });
  syncSwap();
  const label = $("profileLabel");
  if (label) label.textContent = sourceKey;
}
refreshControls();

const round4 = (q) => ({
  x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: +q.z.toFixed(4), w: +q.w.toFixed(4),
});
function currentConfig() {
  return {
    app: "phone-sensor-controller",
    savedAt: new Date().toISOString(),
    activeSource: sourceKey,
    sourceLabel: lastSource,
    profiles, // per-source: { invert, trim, swap }
    refQuat: round4(refQuat),
    liveQuat: round4(liveQuat),
  };
}
function updateDebug() {
  const dbg = $("dbgJson");
  if (!dbg || $("advanced").open === false) return; // skip work when collapsed
  $("dbgSource").textContent = lastSource;
  const rel = qmul(conj(refQuat), liveQuat);
  dbg.textContent = JSON.stringify(
    { source: lastSource, activeProfile: sourceKey, profile: prof(),
      live: round4(liveQuat), ref: round4(refQuat), rel: round4(rel) },
    null, 2
  );
}
setInterval(updateDebug, 200);

$("exportCfg").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(currentConfig(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sensor-settings.json";
  a.click();
  URL.revokeObjectURL(url);
});

$("importCfg").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const cfg = JSON.parse(await file.text());
    if (cfg.profiles) {
      mergeProfile(profiles.euler, cfg.profiles.euler);
      mergeProfile(profiles.quaternion, cfg.profiles.quaternion);
    } else {
      // Legacy single-profile file → apply to the active profile.
      mergeProfile(prof(), { invert: cfg.invert, trim: cfg.trimDeg });
    }
    if (cfg.refQuat) refQuat = cfg.refQuat;
    saveProfiles();
    refreshControls();
    $("calNote").textContent = "Settings imported ✓";
  } catch (err) {
    $("calNote").textContent = "Import failed: " + err.message;
  }
  e.target.value = "";
});

// ---------- Guided calibration wizard ----------
// Walks through poses; the model follows live and the user confirms each axis
// matches or taps to flip it. Result persists via the same invert flags.
const wizSteps = [
  {
    kind: "neutral",
    text: "① Hold the phone UPRIGHT (portrait), screen facing you — the pose you want as “straight ahead.” Then set it as front.",
    primary: "Set as front",
  },
  {
    kind: "axis", axis: "pitch",
    text: "② PITCH — nod it: tilt the TOP edge toward you, then away. Does the on-screen phone lean the same direction?",
  },
  {
    kind: "axis", axis: "yaw",
    text: "③ YAW — like a door on a hinge: keep it upright and facing you, swing the LEFT edge toward you. Does the model turn the same way?",
  },
  {
    kind: "axis", axis: "roll",
    text: "④ ROLL — spin it in its own plane toward landscape: drop the RIGHT edge down. Does the model tilt the same diagonal way?",
  },
  {
    kind: "done",
    text: "All set ✓ The model now mirrors your phone. Settings are saved in this browser.",
    primary: "Finish",
  },
];

let wizAt = -1;
const wizard = $("wizard");
const wizText = $("wizText");
const wizPrimary = $("wizPrimary");
const wizSecondary = $("wizSecondary");
const wizProgress = $("wizProgress");

function renderWizStep() {
  const s = wizSteps[wizAt];
  wizText.textContent = s.text;
  wizProgress.textContent = `Step ${wizAt + 1} of ${wizSteps.length}`;
  if (s.kind === "axis") {
    wizPrimary.textContent = "✓ Matches";
    wizSecondary.textContent = "✗ Flip it";
    wizSecondary.hidden = false;
  } else {
    wizPrimary.textContent = s.primary;
    wizSecondary.hidden = true;
  }
}

function startWizard() {
  wizAt = 0;
  wizard.hidden = false;
  renderWizStep();
}
function endWizard() {
  wizard.hidden = true;
  wizAt = -1;
}

$("wizStart").addEventListener("click", startWizard);

wizPrimary.addEventListener("click", () => {
  const s = wizSteps[wizAt];
  if (s.kind === "neutral") {
    refQuat = liveQuat;
    needZero = false;
    sendHaptic(20);
  } else if (s.kind === "done") {
    endWizard();
    $("calNote").textContent = "Guided calibration complete.";
    return;
  }
  // "axis" primary = matches → leave as-is
  wizAt++;
  renderWizStep();
});

wizSecondary.addEventListener("click", () => {
  const s = wizSteps[wizAt];
  if (s.kind === "axis") {
    prof().invert[s.axis] = !prof().invert[s.axis];
    saveProfiles();
    syncInvert(s.axis);
    sendHaptic([15, 40, 15]);
  }
  wizAt++;
  renderWizStep();
});

const fmt = (n) => (n == null ? "–" : n.toFixed(0) + "°");

// ---------- Game ----------
const cv = $("arena");
const ctx = cv.getContext("2d");
const W = cv.width, H = cv.height, R = 16;
let ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
let target = spawn();

function spawn() {
  const pad = 50;
  return { x: pad + Math.random() * (W - 2 * pad), y: pad + Math.random() * (H - 2 * pad), r: 22 };
}

function step() {
  // gamma (left/right roll) -> x accel, beta (front/back pitch) -> y accel
  const ax = (tilt.gamma || 0) * 0.015;
  const ay = (tilt.beta || 0) * 0.015;
  ball.vx = (ball.vx + ax) * 0.96;
  ball.vy = (ball.vy + ay) * 0.96;
  ball.x += ball.vx;
  ball.y += ball.vy;

  // bounce off walls
  if (ball.x < R) { ball.x = R; ball.vx *= -0.5; }
  if (ball.x > W - R) { ball.x = W - R; ball.vx *= -0.5; }
  if (ball.y < R) { ball.y = R; ball.vy *= -0.5; }
  if (ball.y > H - R) { ball.y = H - R; ball.vy *= -0.5; }

  // pickup
  const d = Math.hypot(ball.x - target.x, ball.y - target.y);
  if (d < R + target.r) {
    scoreVal++;
    $("score").textContent = scoreVal;
    target = spawn();
    sendHaptic([20, 50, 20]); // reward buzz on the phone
  }
  draw();
  leanArena();
  requestAnimationFrame(step);
}

// Tilt the whole arena in 3D so it leans like the phone — same orientation as
// the live model, but softened and angle-capped so it never turns away from you.
function leanArena() {
  const ang = 2 * Math.acos(Math.min(1, Math.abs(shownQuat.w))); // total tilt (rad)
  const f = ang > 1e-4 ? Math.min(0.6, (30 * D2R) / ang) : 0;
  cv.style.transform = quatToMatrix3d(nlerp(ID, shownQuat, f), prof().swap);
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  // target glow
  const g = ctx.createRadialGradient(target.x, target.y, 2, target.x, target.y, target.r * 1.6);
  g.addColorStop(0, "rgba(167,139,250,.9)");
  g.addColorStop(1, "rgba(167,139,250,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(target.x, target.y, target.r * 1.6, 0, 7);
  ctx.fill();
  ctx.fillStyle = "#a78bfa";
  ctx.beginPath();
  ctx.arc(target.x, target.y, target.r, 0, 7);
  ctx.fill();
  // ball
  ctx.fillStyle = "#5eead4";
  ctx.shadowColor = "#5eead4";
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, R, 0, 7);
  ctx.fill();
  ctx.shadowBlur = 0;
}
step();
