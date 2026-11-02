import * as http from "http";

const PORT = process.env.HEALTH_PORT || 8080;

export function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT, () => {
    console.log(`[TELEMETRY] Healthcheck endpoint live on :${PORT}/health`);
  });
}