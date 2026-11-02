import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "HEALTHY",
        uptimeSeconds: process.uptime(),
        timestamp: new Date().toISOString(),
        protocol: "AegisPay",
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(8080, () => {
  console.log("[Healthcheck] HTTP Server live on port 8080");
});