import express from "express";
import https from "node:https";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import selfsigned from "selfsigned";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Hosting platforms (Railway, Render, etc.) inject PORT and terminate TLS at
// their edge, forwarding plain HTTP + WebSocket upgrades to us. Locally we run
// our own HTTPS with a self-signed cert, since phone motion sensors require a
// secure context and a bare LAN IP over http:// does not qualify.
const isCloud = !!process.env.PORT;
const PORT = process.env.PORT || 8443;

// ---- Find LAN IP so we can print a phone-friendly URL ----
function lanIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}
const IP = lanIP();

// ---- Self-signed cert (generated once, cached) ----
const certDir = join(__dirname, ".cert");
const keyPath = join(certDir, "key.pem");
const crtPath = join(certDir, "cert.pem");
if (!isCloud && (!existsSync(keyPath) || !existsSync(crtPath))) {
  if (!existsSync(certDir)) mkdirSync(certDir);
  const attrs = [{ name: "commonName", value: IP }];
  const pems = selfsigned.generate(attrs, {
    days: 825,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: IP },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  });
  writeFileSync(keyPath, pems.private);
  writeFileSync(crtPath, pems.cert);
  console.log("Generated self-signed cert for", IP);
}

const app = express();
// index:false so "/" falls through to our routes: the desktop RECEIVER is the
// root (what a person visiting the site sees), and the phone CONTROLLER lives at
// /phone (where the QR points). Other static assets still serve normally.
app.use(express.static(join(__dirname, "public"), { index: false }));

const page = (name) => (_req, res) => res.sendFile(join(__dirname, "public", name));
app.get(["/", "/laptop", "/laptop.html"], page("laptop.html"));
app.get(["/phone", "/cast"], page("index.html"));

// LAN address so the laptop page can build a phone-reachable URL + QR code.
app.get("/api/info", (_req, res) => res.json({ ip: IP, port: PORT }));

// Render a QR code (SVG) for an arbitrary short string - used to onboard phones
// without typing the LAN IP. Generated locally, nothing leaves the machine.
app.get("/api/qr", async (req, res) => {
  const text = (req.query.text || "").toString().slice(0, 512);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1 });
    res.type("svg").set("Cache-Control", "no-store").send(svg);
  } catch {
    res.status(500).end();
  }
});

const server = isCloud
  ? http.createServer(app)
  : https.createServer({ key: readFileSync(keyPath), cert: readFileSync(crtPath) }, app);

// ---- WebSocket relay ----
// Rooms hold { phones:Set, laptops:Set }. Phones broadcast sensor frames to
// laptops in the same room; laptops can send haptic commands back to phones.
//
// Abuse limits (defense-in-depth behind Cloudflare): a flood that gets past the
// edge still can't exhaust this process. Frames are tiny JSON, so these ceilings
// are generous for real use and tunable via env vars.
const MAX_PAYLOAD = Number(process.env.MC_MAX_PAYLOAD) || 8 * 1024;   // bytes/message
const MAX_CONNS_PER_IP = Number(process.env.MC_MAX_CONNS_PER_IP) || 8;
const MAX_TOTAL_CONNS = Number(process.env.MC_MAX_TOTAL_CONNS) || 1000;
const MSGS_PER_SEC = Number(process.env.MC_MSGS_PER_SEC) || 150;      // per connection

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
const rooms = new Map();
const ipConns = new Map(); // ip -> active connection count
let totalConns = 0;

// Real client IP: Cloudflare/host sets these; fall back to the socket address.
function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function room(name) {
  if (!rooms.has(name)) rooms.set(name, new Set());
  return rooms.get(name);
}

function broadcast(roomName, predicate, payload) {
  const msg = JSON.stringify(payload);
  for (const client of room(roomName)) {
    if (client.readyState === 1 && predicate(client)) client.send(msg);
  }
}

function announcePeers(roomName) {
  const members = [...room(roomName)];
  const phones = members.filter((c) => c.role === "phone").length;
  const laptops = members.filter((c) => c.role === "laptop").length;
  broadcast(roomName, () => true, { type: "peers", phones, laptops });
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  // Refuse connections over the global or per-IP ceilings (1013 = try later).
  if (totalConns >= MAX_TOTAL_CONNS || (ipConns.get(ip) || 0) >= MAX_CONNS_PER_IP) {
    ws.close(1013, "too many connections");
    return;
  }
  totalConns++;
  ipConns.set(ip, (ipConns.get(ip) || 0) + 1);

  ws.role = "unknown";
  ws.room = "default";
  ws.winStart = Date.now();
  ws.winCount = 0;

  ws.on("message", (raw) => {
    // Per-connection message rate limit (sliding 1s window).
    const now = Date.now();
    if (now - ws.winStart >= 1000) { ws.winStart = now; ws.winCount = 0; }
    if (++ws.winCount > MSGS_PER_SEC) { ws.close(1008, "rate limit exceeded"); return; }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "hello") {
      ws.role = data.role === "laptop" ? "laptop" : "phone";
      ws.room = (data.room || "default").toString().slice(0, 32);
      room(ws.room).add(ws);
      announcePeers(ws.room);
      return;
    }

    // Phone -> laptops: sensor frames
    if (data.type === "sensor" && ws.role === "phone") {
      broadcast(ws.room, (c) => c.role === "laptop", data);
      return;
    }

    // Laptop -> phones: haptic feedback requests
    if (data.type === "haptic" && ws.role === "laptop") {
      broadcast(ws.room, (c) => c.role === "phone", data);
      return;
    }

    // Phone -> laptops: "make my current pose the front reference"
    if (data.type === "calibrate" && ws.role === "phone") {
      broadcast(ws.room, (c) => c.role === "laptop", data);
      return;
    }

    // Latency probe: laptop pings phones, each echoes it back as a pong. The
    // laptop carries its own clock in `t`, so round-trip needs no clock sync.
    if (data.type === "ping" && ws.role === "laptop") {
      broadcast(ws.room, (c) => c.role === "phone", data);
      return;
    }
    if (data.type === "pong" && ws.role === "phone") {
      broadcast(ws.room, (c) => c.role === "laptop", data);
      return;
    }
  });

  ws.on("close", () => {
    totalConns = Math.max(0, totalConns - 1);
    const n = (ipConns.get(ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);

    if (rooms.has(ws.room)) {
      const set = room(ws.room);
      set.delete(ws);
      // Drop empty rooms so per-session room ids don't accumulate forever.
      if (set.size === 0) rooms.delete(ws.room);
      else announcePeers(ws.room);
    }
  });
});

server.listen(PORT, () => {
  if (isCloud) {
    console.log(`MotionCast running on port ${PORT} (HTTP; platform terminates TLS).`);
    return;
  }
  console.log("\n  MotionCast running\n");
  console.log("  On this computer (receiver + demo):");
  console.log(`    https://localhost:${PORT}/\n`);
  console.log("  On your phone (the caster) - same Wi-Fi network:");
  console.log(`    https://${IP}:${PORT}/phone\n`);
  console.log("  Accept the self-signed cert warning on first visit.\n");
});

// Local convenience: redirect plain http -> https so a forgotten scheme still
// lands on the secure page. Not needed in the cloud (the platform owns TLS).
if (!isCloud) {
  http
    .createServer((req, res) => {
      res.writeHead(301, { Location: `https://${req.headers.host?.split(":")[0]}:${PORT}${req.url}` });
      res.end();
    })
    .listen(8080, () => console.log("  (http://<ip>:8080 redirects to https)\n"));
}
