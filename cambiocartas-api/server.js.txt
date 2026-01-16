import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: true
}));
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
              type: "text",
              text:
                "En esta foto hay cartas Pokemon (binder). Devuelve SOLO JSON valido, sin texto extra, con este formato exacto: {\"cards\":[{\"name\":\"\"}]}. Solo incluye nombres; si dudas pon el nombre mas probable."
            },
            {
              type: "image_url",
              image_url: {
                url: "data:image/jpeg;base64," + imageBase64
              }
            }
          ]
        }
      ]
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content ?? "";

    // Intentar parsear JSON aunque venga con espacios/saltos
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // fallback: sacar lineas como lista simple
      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
      parsed = { cards: lines.map(name => ({ name })) };
    }

    const names = (parsed.cards || [])
      .map(c => (c?.name || "").trim())
      .filter(Boolean);

    res.json({ cards: names.map(name => ({ name })) });
  } catch (e) {
    res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
