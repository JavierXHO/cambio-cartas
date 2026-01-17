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
  return String(s).split("/")[0].trim();
}

// --------- cache sets 12h ----------
let SETS_CACHE = { at: 0, data: [] };

app.get("/api/sets", async (req, res) => {
  try {
    const now = Date.now();
    if (SETS_CACHE.data.length && now - SETS_CACHE.at < 1000 * 60 * 60 * 12) {
      return res.json({ sets: SETS_CACHE.data });
    }

    const data = await pokemonFetch(`/sets?pageSize=250`);
    const sets = Array.isArray(data?.data) ? data.data : [];

    const clean = sets
      .map(s => ({
        id: s.id,
        name: s.name,
        series: s.series || "",
        releaseDate: s.releaseDate || ""
      }))
      .sort((a, b) => (a.releaseDate || "").localeCompare(b.releaseDate || ""));

    SETS_CACHE = { at: now, data: clean };
    return res.json({ sets: clean });
  } catch {
    return res.status(500).json({ error: "No se pudieron cargar ediciones" });
  }
});

async function findCardImage({ name, collector_number, setId }) {
  const cleanName = String(name || "").replace(/"/g, "").trim();
  const num = normNum(collector_number);

  // 1) Si el usuario eligió edición: intentar EXACTO por set+number (mejor para imagen real)
  if (setId && num) {
    const q = `set.id:${setId} number:${num}`;
    const data = await pokemonFetch(`/cards?q=${encodeURIComponent(q)}&pageSize=5`);
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length) {
      const c = list[0];
      return {
        image_url: c?.images?.small || c?.images?.large || PLACEHOLDER_IMG,
        matched: { set: c?.set?.name || "", number: c?.number || "" }
      };
    }
  }

  // 2) Si no hay match exacto: buscar por nombre (fallback)
  if (cleanName) {
    const q2 = `name:${cleanName}`;
    const data2 = await pokemonFetch(`/cards?q=${encodeURIComponent(q2)}&pageSize=1`);
    const list2 = Array.isArray(data2?.data) ? data2.data : [];
    if (list2.length) {
      const c = list2[0];
      return {
        image_url: c?.images?.small || c?.images?.large || PLACEHOLDER_IMG,
        matched: { set: c?.set?.name || "", number: c?.number || "" }
      };
    }
  }

  return { image_url: PLACEHOLDER_IMG, matched: null };
}

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64, setId } = req.body;

    if (!imageBase64) return res.status(400).json({ error: "Falta imageBase64" });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });

    // Detectar cartas con IA
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
                "{\"cards\":[{\"name\":\"\",\"set\":\"\",\"collector_number\":\"\",\"confidence\":0.0}]}\n" +
                "Reglas:\n" +
                "- set: si no se ve pon \"\"\n" +
                "- collector_number: si no se ve pon \"\"\n"
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

    // Enriquecer con imagen exacta si setId fue elegido
    const enriched = [];
    for (const c of cards) {
      const { image_url, matched } = await findCardImage({
        name: c.name,
        collector_number: c.collector_number,
        setId: setId || null
      });

      enriched.push({
        ...c,
        image_url,
        matched
      });
    }

    return res.json({ cards: enriched });
  } catch {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
