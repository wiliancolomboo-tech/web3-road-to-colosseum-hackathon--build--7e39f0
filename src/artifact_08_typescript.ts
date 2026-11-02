import express from "express";
const app = express();
app.get("/health", async (req, res) => {
  try {
    const slot = await connection.getSlot();
    const balance = await connection.getBalance(keeperKeypair.publicKey);
    if (balance < 0.05 * LAMPORTS_PER_SOL) {
      return res.status(500).json({ status: "DEGRADED", reason: "Low keeper balance", balance, slot });
    }
    return res.status(200).json({ status: "HEALTHY", slot, balanceLamports: balance });
  } catch (err: any) {
    return res.status(503).json({ status: "UNHEALTHY", error: err.message });
  }
});
app.listen(8080, () => console.log("Telemetry endpoint active on :8080"));