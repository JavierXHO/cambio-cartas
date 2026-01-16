import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const PLACEHOLDER_IMG =
  "https://via.placeholder.com/220x308.png?text=No+Image";

app.get("/api/health", (req, res) => res.json({ ok: true }));

function normalizeCollectorNumber(s) {
  if (!s) return "";
  return String(s).split("/")[0].trim(); // "12/108" -> "12"
}

async function pokemonTcgSearchCard({ name, collector_number, setName }) {
  const apiKey = process.env.POKEMONTCG_API_KEY;
  if (!apiKey) return null;

  const cleanName = String(name || "").replace(/"/g, "").trim();
  if (!cleanName) return null;

  const num = normalizeCollectorNumber(collector_number);

  // Query v2: name:"..." number:"..." (si hay número)
  let q = `name:"${cleanName}"`;
  if (num) q += ` number:"${String(num).replace(/"/g, "")}"`;

  const url = `${POKEMONTCG_BASE}/cards?q=${encodeURIComponent(q)}&pageSize=20`;

  const r = await fetch(url, {
    headers: { "X-Api-Key": apiKey }
  });

  if (!r.ok) return null;

  const data = await r.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  if (!list.length) return null;

  // Mejor match por set si viene
  if (setName) {
    const target = String(setName).toLowerCase();
    const bySet = list.find(c =>
      String(c?.set?.name || "").toLowerCase().includes(target)
    );
    if (bySet) return bySet;
  }

  return list[0];
}

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Falta imageBase64" });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });

    // 1) Detectar nombres con OpenAI
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
      cards = parsed.cards.map((c) => ({
        name: (c?.name || "").toString().trim().replace(/[`"]/g, ""),
        set: (c?.set || "").toString().trim().replace(/[`"]/g, ""),
        collector_number: (c?.collector_number || "").toString().trim().replace(/[`"]/g, ""),
        confidence: Math.max(0, Math.min(1, Number(c?.confidence ?? 0)))
      }));
    }
    cards = cards.filter(c => c.name);

    // 2) Enriquecer: buscar imagen oficial con PokémonTCG
    const enriched = [];
    for (const c of cards) {
      const found = await pokemonTcgSearchCard({
        name: c.name,
        collector_number: c.collector_number,
        setName: c.set
      });

      const image_url =
        found?.images?.large ||
        found?.images?.small ||
        PLACEHOLDER_IMG;

      enriched.push({
        ...c,
        image_url
      });
    }

    return res.json({ cards: enriched });
  } catch (e) {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
