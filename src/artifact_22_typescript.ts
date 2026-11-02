import * as http from 'http';
import { Connection } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PORT = process.env.PORT || 8080;
const connection = new Connection(RPC_URL, 'confirmed');

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    try {
      const slot = await connection.getSlot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'HEALTHY',
        solana_rpc: RPC_URL,
        current_slot: slot,
        timestamp: new Date().toISOString()
      }));
    } catch (e: any) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'UNHEALTHY', error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[Telemetry] Healthcheck daemon listening on port ${PORT}`);
});