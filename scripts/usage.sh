#!/bin/sh
# Per-user LLM token usage (today / this month, UTC) from the running stack, via the gateway container,
# which holds the proxy admin secret. Usage: scripts/usage.sh [user-id]
set -eu
GATEWAY="${GATEWAY_CONTAINER:-dshcloud-gateway-1}"
docker exec "$GATEWAY" node -e '
import http from "node:http";
const [id] = process.argv.slice(1);
const path = "/admin/usage" + (id ? "/" + id : "");
const rows = await new Promise((resolve, reject) => {
  const req = http.request({ socketPath: process.env.LLM_ADMIN_SOCKET, path, headers: { authorization: "Bearer " + process.env.LLM_ADMIN_SECRET } }, (res) => {
    let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve(JSON.parse(t)));
  });
  req.on("error", reject); req.end();
});
const list = Array.isArray(rows) ? rows : [rows];
const lim = (w) => (w.limit === null ? "unlimited" : w.limit);
console.log("user  today (limit)           month (limit)           blocked");
for (const r of list) console.log(String(r.userId).padEnd(5), `${r.day.used} (${lim(r.day)})`.padEnd(23), `${r.month.used} (${lim(r.month)})`.padEnd(23), r.blockedBy ?? "-");
' --input-type=module "${1:-}"
