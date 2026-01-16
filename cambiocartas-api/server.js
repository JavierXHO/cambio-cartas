import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const PLACEHOLDER_IMG = "https://images.pokemontcg.io/base1/4.png";

app.get("/api/health", (req, res) => res.json({ ok: true }));

function normNum(s) {
  if (!s) return "";
  return String(s).split("/")[0].trim(); // "12/108" -> "12"
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

async function pokemonFetch(path) {
  const apiKey = process.env.POKEMONTCG_API_KEY;
  if (!apiKey) return null;

  const r = await fetch(`${POKEMONTCG_BASE}${path}`, {
    headers: { "X-Api-Key": apiKey }
  });
  if (!r.ok) return null;
  return await r.json();
}

// --- Cache de sets (para no pedirlos cada vez) ---
let SETS_CACHE = { at: 0, data: [] };

async function getAllSets() {
  const now = Date.now();
  if (SETS_CACHE.data.length && now - SETS_CACHE.at < 1000 * 60 * 60 * 12) {
    return SETS_CACHE.data; // 12h cache
  }

  // Traemos muchos sets en 1-2 llamadas (pageSize alto)
  const data = await pokemonFetch(`/sets?pageSize=250`);
  const sets = Array.isArray(data?.data) ? data.data : [];

  SETS_CACHE = { at: now, data: sets };
  return sets;
}

async function findSetIdByName(setName) {
  const wanted = normText(setName);
  if (!wanted) return null;

  const sets = await getAllSets();
  if (!sets.length) return null;

  // match exacto por nombre normalizado
  let hit = sets.find(s => normText(s.name) === wanted);
  if (hit?.id) return hit.id;

  // match parcial (contiene)
  hit = sets.find(s => normText(s.name).includes(wanted) || wanted.includes(normText(s.name)));
  if (hit?.id) return hit.id;

  return null;
}

async function findCardBySetAndNumber(setName, collectorNumber) {
  const number = normNum(collectorNumber);
  const setId = await findSetIdByName(setName);

  // 1) Exacto: set.id + number
  if (setId && number) {
    const q = `set.id:${setId} number:${number}`;
    const data = await pokemonFetch(`/cards?q=${encodeURIComponent(q)}&pageSize=5`);
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length) return list[0];
  }

  // 2) Semi: set.name + number (por si setId no calzó)
  if (setName && number) {
    const cleanSet = String(setName).replace(/"/g, "");
    const q = `set.name:"${cleanSet}" number:${number}`;
    const data = await pokemonFetch(`/cards?q=${encodeURIComponent(q)}&pageSize=5`);
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length) return list[0];
  }

  return null;
}

async function findCardFallbackByName(name) {
  const cleanName = String(name || "").replace(/"/g, "").trim();
  if (!cleanName) return null;

  // fallback suave por nombre
  const q = `name:${cleanName}`;
  const data = await pokemonFetch(`/cards?q=${encodeURIComponent(q)}&pageSize=1`);
  const list = Array.isArray(data?.data) ? data.data : [];
  return list[0] || null;
}

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Falta imageBase64" });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });

    // Pedimos explícito set + collector_number (edición + número)
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
                "- set: nombre de la edición/expansión (ej: \"Evolutions\", \"Roaring Skies\").\n" +
                "- collector_number: número visible (ej \"64/108\" o \"64\").\n" +
                "- confidence 0.0 a 1.0.\n"
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

    const enriched = [];
    for (const c of cards) {
      // 1) Intento exacto por set + number
      let found = await findCardBySetAndNumber(c.set, c.collector_number);

      // 2) Fallback por nombre si lo exacto falla
      if (!found) found = await findCardFallbackByName(c.name);

      const image_url =
        found?.images?.large ||
        found?.images?.small ||
        PLACEHOLDER_IMG;

      // Opcional: te devuelvo “set real” y “number real” que encontró la API
      enriched.push({
        ...c,
        image_url,
        matched: found ? {
          id: found.id,
          set: found?.set?.name || "",
          number: found?.number || ""
        } : null
      });
    }

    return res.json({ cards: enriched });
  } catch {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
