import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

// Imagen (PokemonTCG)
const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const PLACEHOLDER_IMG = "https://images.pokemontcg.io/base1/4.png";

// Precios (TCGdex)
const TCGDEX_BASE = "https://api.tcgdex.net/v2/en";

app.get("/api/health", (req, res) => res.json({ ok: true }));

function normNum(s) {
  if (!s) return "";
  return String(s).split("/")[0].trim(); // "64/108" -> "64"
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ---------------- PokemonTCG (imagenes) ----------------
async function pokemonFetch(path) {
  const apiKey = process.env.POKEMONTCG_API_KEY;
  if (!apiKey) return null;

  const r = await fetch(`${POKEMONTCG_BASE}${path}`, {
    headers: { "X-Api-Key": apiKey }
  });
  if (!r.ok) return null;
  return await r.json();
}

async function findImageUrl(name, collector_number) {
  const cleanName = String(name || "").replace(/"/g, "").trim();
  const n = normNum(collector_number);

  if (!cleanName) return PLACEHOLDER_IMG;

  // 1) name + number (más exacto)
  if (n) {
    const q1 = `name:"${cleanName}" number:"${n}"`;
    const d1 = await pokemonFetch(`/cards?q=${encodeURIComponent(q1)}&pageSize=5`);
    const list1 = Array.isArray(d1?.data) ? d1.data : [];
    const hit1 = list1[0];
    const img1 = hit1?.images?.small || hit1?.images?.large;
    if (img1) return img1;
  }

  // 2) fallback: name solo
  const q2 = `name:${cleanName}`;
  const d2 = await pokemonFetch(`/cards?q=${encodeURIComponent(q2)}&pageSize=1`);
  const list2 = Array.isArray(d2?.data) ? d2.data : [];
  const hit2 = list2[0];
  const img2 = hit2?.images?.small || hit2?.images?.large;

  return img2 || PLACEHOLDER_IMG;
}

// ---------------- TCGdex (precios USD/EUR) ----------------
async function tcgdexSearchByName(name) {
  const url = `${TCGDEX_BASE}/cards?name=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function tcgdexGetCardById(id) {
  const url = `${TCGDEX_BASE}/cards/${encodeURIComponent(id)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return await r.json();
}

function pickBestCandidate(candidates, wantedLocalId) {
  if (!candidates.length) return null;

  // intenta calzar número (localId en tcgdex suele ser el número del set)
  if (wantedLocalId) {
    const exact = candidates.find(c => String(c.localId) === String(wantedLocalId));
    if (exact) return exact;

    const starts = candidates.find(c => String(c.localId).startsWith(String(wantedLocalId)));
    if (starts) return starts;
  }

  return candidates[0];
}

function extractPricesFromTcgdexCard(fullCard) {
  const pricing = fullCard?.pricing || {};
  const tcg = pricing?.tcgplayer || null;
  const cm = pricing?.cardmarket || null;

  // USD: prioridad marketPrice, si no midPrice
  const usd =
    safeNumber(tcg?.normal?.marketPrice) ??
    safeNumber(tcg?.holofoil?.marketPrice) ??
    safeNumber(tcg?.["reverse-holofoil"]?.marketPrice) ??
    safeNumber(tcg?.normal?.midPrice) ??
    safeNumber(tcg?.holofoil?.midPrice) ??
    safeNumber(tcg?.["reverse-holofoil"]?.midPrice) ??
    null;

  // EUR: prioridad trend, si no avg
  const eur =
    safeNumber(cm?.trend) ??
    safeNumber(cm?.["trend-holo"]) ??
    safeNumber(cm?.avg) ??
    safeNumber(cm?.["avg-holo"]) ??
    null;

  return { price_usd: usd, price_eur: eur };
}

async function findPrices(name, collector_number) {
  const wantedLocalId = normNum(collector_number);
  const candidates = await tcgdexSearchByName(name);
  const best = pickBestCandidate(candidates, wantedLocalId);

  if (!best?.id) return { price_usd: null, price_eur: null };

  const full = await tcgdexGetCardById(best.id);
  if (!full) return { price_usd: null, price_eur: null };

  return extractPricesFromTcgdexCard(full);
}

// ---------------- SCAN ----------------
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

    const enriched = [];
    for (const c of cards) {
      const image_url = await findImageUrl(c.name, c.collector_number);
      const prices = await findPrices(c.name, c.collector_number);

      enriched.push({
        ...c,
        image_url,
        price_usd: prices.price_usd,
        price_eur: prices.price_eur
      });
    }

    return res.json({ cards: enriched });
  } catch {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
