// Add to sentinel.ts for production readiness:
import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    return;
  }
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      uptime_seconds: process.uptime(),
      memory_usage: process.memoryUsage(),
      active_connections: 1,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`[Healthcheck] Telemetry endpoint running on port ${process.env.PORT || 8080}`);
});