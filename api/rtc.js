const { matchmake, leave, signal, poll } = require("../lib/matchmaker");
const store = require("../lib/store");

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const { action, id } = body || {};
  if (!id || typeof id !== "string" || id.length > 64) {
    res.status(400).json({ error: "Missing or invalid id" });
    return;
  }

  try {
    switch (action) {
      case "join": {
        const result = await matchmake(id);
        res.status(200).json({ backend: store.backend, ...result });
        return;
      }
      case "poll": {
        const result = await poll(id);
        res.status(200).json(result);
        return;
      }
      case "signal": {
        await signal(id, body.data);
        res.status(200).json({ ok: true });
        return;
      }
      case "leave": {
        await leave(id);
        res.status(200).json({ ok: true });
        return;
      }
      case "next": {
        await leave(id);
        const result = await matchmake(id);
        res.status(200).json(result);
        return;
      }
      default:
        res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    console.error("rtc error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
