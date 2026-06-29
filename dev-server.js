// Local development server ONLY. Vercel does not use this file.
// It serves the static frontend and mounts the same serverless API handler
// so you can run the app locally (and across your LAN) with `npm run dev`.
//
// Uses the in-memory store automatically (no Vercel KV needed locally).

const express = require("express");
const os = require("os");
const path = require("path");
const rtcHandler = require("./api/rtc");

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.all("/api/rtc", (req, res) => rtcHandler(req, res));

function getLocalIPs() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("\n  Omegle-style chat (local dev) is running!\n");
  console.log(`  Local:   http://localhost:${PORT}`);
  getLocalIPs().forEach((ip) => console.log(`  Network: http://${ip}:${PORT}`));
  console.log("\n  Note: camera/mic require HTTPS on remote devices; localhost is exempt.\n");
});
