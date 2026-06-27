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
if (!existsSync(keyPath) || !existsSync(crtPath)) {
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
app.use(express.static(join(__dirname, "public")));
app.get(["/laptop", "/laptop.html"], (_req, res) =>
  res.sendFile(join(__dirname, "public", "laptop.html"))
);

// LAN address so the laptop page can build a phone-reachable URL + QR code.
app.get("/api/info", (_req, res) => res.json({ ip: IP, port: PORT }));

// Render a QR code (SVG) for an arbitrary short string — used to onboard phones
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

const server = https.createServer(
  { key: readFileSync(keyPath), cert: readFileSync(crtPath) },
  app
);

// ---- WebSocket relay ----
// Rooms hold { phones:Set, laptops:Set }. Phones broadcast sensor frames to
// laptops in the same room; laptops can send haptic commands back to phones.
const wss = new WebSocketServer({ server });
const rooms = new Map();

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

wss.on("connection", (ws) => {
  ws.role = "unknown";
  ws.room = "default";

  ws.on("message", (raw) => {
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
    if (rooms.has(ws.room)) {
      room(ws.room).delete(ws);
      announcePeers(ws.room);
    }
  });
});

server.listen(PORT, () => {
  console.log("\n  Phone Sensor Controller running\n");
  console.log("  On this laptop (game view):");
  console.log(`    https://localhost:${PORT}/laptop\n`);
  console.log("  On your phone (controller) — same Wi-Fi network:");
  console.log(`    https://${IP}:${PORT}/\n`);
  console.log("  Accept the self-signed cert warning on first visit.\n");
});

// Friendly redirect from plain http -> https, in case someone forgets it.
http
  .createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host?.split(":")[0]}:${PORT}${req.url}` });
    res.end();
  })
  .listen(8080, () => console.log("  (http://<ip>:8080 redirects to https)\n"));
