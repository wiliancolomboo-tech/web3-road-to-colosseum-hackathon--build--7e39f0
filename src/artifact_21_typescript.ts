// Embedded in client index / daemon
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), network: "solana" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(8080, () => console.log("[HEALTHCHECK] Server listening on port 8080"));