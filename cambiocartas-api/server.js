import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const POKEMON_API_KEY =
  process.env.POKEMON_API_KEY ||
  process.env.POKEMONTCG_API_KEY ||
  "";

const PLACEHOLDER_IMG = "https://images.pokemontcg.io/base1/1.png";

/* ---------------- UTILIDADES ---------------- */

function normNum(n) {
  return String(n || "")
    .split("/")
    .shift()
    .replace(/[^\d]/g, "")
    .trim();
}

function normalizeNameForMatch(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonBlock(text) {
  if (!text) return "";
  return String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

/* ---------------- POKEMON API ---------------- */

async function pokemonFetch(url) {
  const res = await fetch("https://api.pokemontcg.io/v2" + url, {
    headers: {
      "X-Api-Key": POKEMON_API_KEY,
    },
  });

  return res.json();
}

async function findImageUrl(name, collector_number) {
  const cleanName = String(name || "").replace(/"/g, "").trim();
  const n = normNum(collector_number);

  if (!cleanName) return PLACEHOLDER_IMG;

  const wantedName = normalizeNameForMatch(cleanName);

  // 1) nombre + número
  if (n) {
    const q1 = `name:"${cleanName}" number:"${n}"`;
    const d1 = await pokemonFetch(`/cards?q=${encodeURIComponent(q1)}&pageSize=10`);
    const list1 = Array.isArray(d1?.data) ? d1.data : [];

    const exact1 = list1.find(
      (card) =>
        normalizeNameForMatch(card?.name) === wantedName &&
        String(card?.number || "") === String(n)
    );

    if (exact1?.images?.small || exact1?.images?.large) {
      return exact1.images.small || exact1.images.large;
    }
  }

  // 2) solo nombre exacto
  const q2 = `name:"${cleanName}"`;
  const d2 = await pokemonFetch(`/cards?q=${encodeURIComponent(q2)}&pageSize=10`);
  const list2 = Array.isArray(d2?.data) ? d2.data : [];

  const exact2 = list2.find(
    (card) => normalizeNameForMatch(card?.name) === wantedName
  );

  if (exact2?.images?.small || exact2?.images?.large) {
    return exact2.images.small || exact2.images.large;
  }

  return PLACEHOLDER_IMG;
}

async function findPrices(name) {
  try {
    const q = `name:"${name}"`;
    const data = await pokemonFetch(`/cards?q=${encodeURIComponent(q)}&pageSize=1`);
    const card = data?.data?.[0];

    const usd =
      card?.tcgplayer?.prices?.holofoil?.market ||
      card?.tcgplayer?.prices?.normal?.market ||
      null;

    const eur = card?.cardmarket?.prices?.averageSellPrice || null;

    return { usd, eur };
  } catch {
    return { usd: null, eur: null };
  }
}

/* ---------------- OPENAI DETECCIÓN ---------------- */

async function detectCardsWithOpenAI(imageBase64) {
  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Eres un detector de cartas Pokémon en fotos de binders. Debes responder SOLO JSON válido."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                'Analiza la imagen y detecta las cartas Pokémon visibles. ' +
                'Devuelve SOLO un JSON válido con esta estructura exacta: ' +
                '{"cards":[{"name":"","set":"","collector_number":"","confidence":0.0}]}. ' +
                'Si no estás seguro del set o número, déjalos vacíos. ' +
                'No escribas texto fuera del JSON.'
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`
              }
            }
          ]
        }
      ],
      max_tokens: 900
    }),
  });

  const json = await openaiRes.json();
  const raw = json?.choices?.[0]?.message?.content || "";

  return raw;
}

function parseDetectedCards(rawText) {
  const cleaned = extractJsonBlock(rawText);

  // intento 1: JSON directo
  let parsed = safeJsonParse(cleaned);
  if (parsed && Array.isArray(parsed.cards)) {
    return parsed.cards
      .map((c) => ({
        name: String(c?.name || "").trim(),
        set: String(c?.set || "").trim(),
        collector_number: String(c?.collector_number || "").trim(),
        confidence:
          typeof c?.confidence === "number"
            ? c.confidence
            : Number(c?.confidence || 0),
      }))
      .filter((c) => c.name);
  }

  // intento 2: si viene un array directo
  parsed = safeJsonParse(cleaned);
  if (Array.isArray(parsed)) {
    return parsed
      .map((c) => ({
        name: String(c?.name || "").trim(),
        set: String(c?.set || "").trim(),
        collector_number: String(c?.collector_number || "").trim(),
        confidence:
          typeof c?.confidence === "number"
            ? c.confidence
            : Number(c?.confidence || 0),
      }))
      .filter((c) => c.name);
  }

  // intento 3: fallback muy simple para rescatar nombres
  const possibleLines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("{") && !l.startsWith("}") && !l.startsWith("[") && !l.startsWith("]"));

  return possibleLines.slice(0, 9).map((line) => ({
    name: line.replace(/^[-•\d.\s]+/, "").trim(),
    set: "",
    collector_number: "",
    confidence: 0.4,
  })).filter((c) => c.name);
}

/* ---------------- RUTAS ---------------- */

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "missing_image" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_openai_key" });
    }

    const rawText = await detectCardsWithOpenAI(imageBase64);
    const cards = parseDetectedCards(rawText);

    if (!cards.length) {
      return res.json({ cards: [] });
    }

    const result = [];

    for (const card of cards) {
      const img = await findImageUrl(card.name, card.collector_number);
      const prices = await findPrices(card.name);

      result.push({
        name: card.name || "",
        set: card.set || "",
        collector_number: card.collector_number || "",
        confidence:
          typeof card.confidence === "number" && !Number.isNaN(card.confidence)
            ? Math.max(0, Math.min(1, card.confidence))
            : 0.5,
        image_url: img,
        price_usd: prices.usd,
        price_eur: prices.eur,
      });
    }

    res.json({ cards: result });
  } catch (err) {
    console.error("SCAN ERROR:", err);
    res.status(500).json({ error: "scan_failed" });
  }
});

/* ---------------- SERVER ---------------- */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
