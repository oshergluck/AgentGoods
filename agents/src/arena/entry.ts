/**
 * One image, two roles.
 *
 * Every service in the arena project runs this same package; ARENA_ROLE decides what the process
 * is. `coordinator` is the arena itself — the ledger, the faucet, twenty agent loops, the
 * supervisor, the scoring — and `executor` is one agent's container: a Node runtime on its own
 * volume that runs whatever its agent sends. Keeping them in one image means a fix ships to all
 * twenty-one services with one deploy each, and nothing can drift between what the coordinator
 * expects and what an executor provides.
 */

const role = (process.env.ARENA_ROLE ?? "").trim().toLowerCase();

if (role === "executor") {
  void import("../executor/server");
} else if (role === "hold") {
  /*
   * Deployed but not started. The image is in place, the executors are up, and the operator has
   * not yet said "go" — a run begins by switching ARENA_ROLE to coordinator, never by a deploy.
   * /health answers so the service reads as live; nothing else happens.
   */
  void import("node:http").then((http) => {
    http.createServer((req, res) => {
      /* Same rule as the running supervisor: an empty 404 to anything but the random path + token. */
      const ok = req.url === (process.env.ARENA_STATUS_PATH ?? "/status") && req.headers["x-arena-token"] === process.env.ARENA_STATUS_TOKEN;
      if (!ok) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: "hold" }));
    }).listen(Number(process.env.PORT ?? 8080), "::", () => console.log("coordinator on hold: set ARENA_ROLE=coordinator to start"));
  });
} else if (role === "coordinator") {
  process.argv.push("start");
  if (!process.argv.includes("--minutes")) process.argv.push("--minutes", process.env.ARENA_MINUTES ?? "240");
  if (!process.argv.includes("--agents")) process.argv.push("--agents", process.env.ARENA_AGENTS ?? "20");
  void import("./arena");
} else {
  console.error("ARENA_ROLE must be 'coordinator' or 'executor'");
  process.exit(1);
}
