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
              type: "text",
              text:
                "En esta foto hay un binder con 9 cartas Pokémon.\n" +
                "Devuelve SOLO JSON válido, SIN markdown y SIN ```.\n" +
                "Formato exacto:\n" +
                "{\"cards\":[{\"name\":\"\",\"set\":\"\",\"collector_number\":\"\",\"confidence\":0.0}]}\n" +
                "Reglas:\n" +
                "- confidence entre 0.0 y 1.0\n" +
                "- set: nombre del set/expansión si se puede inferir, si no pon \"\"\n" +
                "- collector_number: el número de colección si se ve (ej: \"12/108\" o \"12\"), si no pon \"\"\n" +
                "- Si una carta se repite, inclúyela igual.\n"
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

    // ----- Parsear y normalizar salida -----
    let text = data?.choices?.[0]?.message?.content ?? "";
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    let cards = [];

    if (parsed && Array.isArray(parsed.cards)) {
      cards = parsed.cards.map((c) => ({
        name: (c?.name || "").toString().trim(),
        set: (c?.set || "").toString().trim(),
        collector_number: (c?.collector_number || "").toString().trim(),
        confidence: Number(c?.confidence ?? 0)
      }));
    } else {
      // fallback: si algo sale mal, devuelvo solo nombres
      const lines = text
        .split("\n")
        .map((s) => s.replace(/^[-•\d.]+\s*/, "").trim())
        .filter(Boolean);

      cards = lines.map((name) => ({
        name,
        set: "",
        collector_number: "",
        confidence: 0.3
      }));
    }

    // limpieza final
    cards = cards
      .filter((c) => c.name)
      .map((c) => ({
        name: c.name.replace(/[`"]/g, "").trim(),
        set: c.set.replace(/[`"]/g, "").trim(),
        collector_number: c.collector_number.replace(/[`"]/g, "").trim(),
        confidence: Math.max(0, Math.min(1, isNaN(c.confidence) ? 0 : c.confidence))
      }));

    return res.json({ cards });
  } catch (e) {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
