import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const PLACEHOLDER_IMG = "https://images.pokemontcg.io/base1/4.png";

app.get("/api/health", (req, res) => res.json({ ok: true }));

async function pokemonFetch(path) {
  const apiKey = process.env.POKEMONTCG_API_KEY;
  if (!apiKey) return null;

  const r = await fetch(`${POKEMONTCG_BASE}${path}`, {
    headers: { "X-Api-Key": apiKey }
  });
  if (!r.ok) return null;
  return await r.json();
}

function normNum(s) {
  if (!s) return "";
  return String(s).split("/")[0].trim(); // "64/108" -> "64"
}

// 2 pasos:
// 1) name + number (si hay)
// 2) name solo (fallback)
// SIEMPRE devuelve una image_url válida
async function findImageUrl(name, collector_number) {
  const cleanName = String(name || "").replace(/"/g, "").trim();
  const n = normNum(collector_number);

  if (!cleanName) return PLACEHOLDER_IMG;

  // 1) Intento con name + number (más exacto)
  if (n) {
    const q1 = `name:"${cleanName}" number:"${n}"`;
    const d1 = await pokemonFetch(`/cards?q=${encodeURIComponent(q1)}&pageSize=5`);
    const list1 = Array.isArray(d1?.data) ? d1.data : [];
    const hit1 = list1[0];
    const img1 = hit1?.images?.small || hit1?.images?.large;
    if (img1) return img1;
  }

  // 2) Fallback solo nombre
  const q2 = `name:${cleanName}`;
  const d2 = await pokemonFetch(`/cards?q=${encodeURIComponent(q2)}&pageSize=1`);
  const list2 = Array.isArray(d2?.data) ? d2.data : [];
  const hit2 = list2[0];
  const img2 = hit2?.images?.small || hit2?.images?.large;

  return img2 || PLACEHOLDER_IMG;
}

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Falta imageBase64" });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });

    // Detectar cartas (name / set / collector_number)
    const payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "En esta foto hay un binder con cartas Pokémon.\n" +
                "Devuelve SOLO JSON válido (sin markdown, sin ```).\n" +
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
      cards = parsed.cards
        .map(c => ({
          name: String(c?.name || "").trim(),
          set: String(c?.set || "").trim(),
          collector_number: String(c?.collector_number || "").trim(),
          confidence: Math.max(0, Math.min(1, Number(c?.confidence ?? 0)))
        }))
        .filter(c => c.name);
    }

    // Enriquecer con image_url (SIEMPRE)
    const enriched = [];
    for (const c of cards) {
      const image_url = await findImageUrl(c.name, c.collector_number);
      enriched.push({ ...c, image_url });
    }

    return res.json({ cards: enriched });
  } catch {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
