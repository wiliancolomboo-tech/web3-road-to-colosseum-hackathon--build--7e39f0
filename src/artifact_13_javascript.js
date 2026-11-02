const http = require('http');
let lastScanTimestamp = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const isHealthy = Date.now() - lastScanTimestamp < 60000;
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isHealthy ? 'UP' : 'STALE', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080);