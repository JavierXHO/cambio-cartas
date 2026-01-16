import express from "express";
import cors from "cors";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "Falta imageBase64" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });
    }

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
