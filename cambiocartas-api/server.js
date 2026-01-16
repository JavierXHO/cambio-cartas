import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const PLACEHOLDER_IMG = "https://via.placeholder.com/220x308.png?text=No+Image";

app.get("/api/health", (req, res) => res.json({ ok: true }));

function normNum(s) {
  if (!s) return "";
  return String(s).split("/")[0].trim(); // "12/108" -> "12"
}

async function pokemonTcgFetch(q) {
  const apiKey = process.env.POKEMONTCG_API_KEY;
  if (!apiKey) return [];

  const url = `${POKEMONTCG_BASE}/cards?q=${encodeURIComponent(q)}&pageSize=25`;

  const r = await fetch(url, { headers: { "X-Api-Key": apiKey } });
  if (!r.ok) return [];

  const data = await r.json();
  return Array.isArray(data?.data) ? data.data : [];
}

// Busca carta con 2 intentos:
// 1) estricto (name + number)
// 2) suave (solo name) para no quedarse sin resultados
async function findCardImage({ name, collector_number }) {
  const cleanName = String(name || "").replace(/"/g, "").trim();
  const n = normNum(collector_number);

  if (!cleanName) return PLACEHOLDER_IMG;

  // Intento 1 (más preciso): name + number
  if (n) {
    const strictQ = `name:"${cleanName}" number:"${n}"`;
    const strict = await pokemonTcgFetch(strictQ);
    const hit = strict[0];
    const img = hit?.images?.large || hit?.images?.small;
    if (img) return img;
  }

  // Intento 2 (más flexible): name sin comillas (ejemplo docs: name:gardevoir) :contentReference[oaicite:1]{index=1}
  const looseQ = `name:${cleanName}`;
  const loose = await pokemonTcgFetch(looseQ);

  // Si hay número, preferir el que coincida
  if (n) {
    const matchNum = loose.find(c => String(c?.number || "") === String(n));
    const img = matchNum?.images?.large || matchNum?.images?.small;
    if (img) return img;
  }

  // Si no, tomar el primero
  const first = loose[0];
  const img = first?.images?.large || first?.images?.small;

  return img || PLACEHOLDER_IMG;
}

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Falta imageBase64" });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "En esta foto hay un binder con varias cartas Pokémon.\n" +
                "Devuelve SOLO JSON válido, SIN markdown y SIN ```.\n" +
                "Formato exacto:\n" +
                "{\"cards\":[{\"name\":\"\",\"set\":\"\",\"collector_number\":\"\",\"confidence\":0.0}]}\n"
            },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64," + imageBase64 } }
          ]
        }
      ]
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();

    let text = data?.choices?.[0]?.message?.content ?? "";
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    let cards = [];
    if (parsed && Array.isArray(parsed.cards)) {
      cards = parsed.cards.map(c => ({
        name: String(c?.name || "").trim(),
        set: String(c?.set || "").trim(),
        collector_number: String(c?.collector_number || "").trim(),
        confidence: Math.max(0, Math.min(1, Number(c?.confidence ?? 0)))
      })).filter(c => c.name);
    }

    // Enriquecer con imagen por carta
    const enriched = [];
    for (const c of cards) {
      const image_url = await findCardImage({
        name: c.name,
        collector_number: c.collector_number
      });

      enriched.push({ ...c, image_url });
    }

    return res.json({ cards: enriched });
  } catch {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
