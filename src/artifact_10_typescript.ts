// Add into client/keeper.ts:
import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "UP",
      timestamp: Date.now(),
      cluster: RPC_ENDPOINT,
      programId: PROGRAM_ID.toBase58(),
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(8080, () => console.log("[Telemetry] Healthcheck server live on :8080/health"));