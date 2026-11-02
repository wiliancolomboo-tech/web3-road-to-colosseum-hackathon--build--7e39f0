import http from "http";

const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            status: "HEALTHY",
            cluster: process.env.SOLANA_RPC_URL,
            timestamp: Date.now(),
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});
server.listen(8080);