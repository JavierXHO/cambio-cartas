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

    let text = data?.choices?.[0]?.message?.content ?? "";
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    let names = [];

    if (parsed && Array.isArray(parsed.cards)) {
      names = parsed.cards.map((c) => (typeof c === "string" ? c : c?.name || ""));
    } else {
      names = text
        .split("\n")
        .map((s) => s.replace(/^[-•\d.]+\s*/, "").trim())
        .filter(Boolean);
    }

    names = names
      .map((n) => n.replace(/[`"]/g, "").trim())
      .filter(Boolean);

    const unique = [...new Set(names)];

    return res.json({ cards: unique.map((name) => ({ name })) });
  } catch (e) {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));

