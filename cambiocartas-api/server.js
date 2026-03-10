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

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

/* ---------------- POKEMON API ---------------- */

async function pokemonFetch(url) {
  const headers = {};

  if (POKEMON_API_KEY) {
    headers["X-Api-Key"] = POKEMON_API_KEY;
  }

  const res = await fetch("https://api.pokemontcg.io/v2" + url, { headers });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`pokemon_api_http_${res.status}: ${txt}`);
  }

  return res.json();
}

async function findImageUrl(name, collector_number) {
  try {
    const cleanName = String(name || "").replace(/"/g, "").trim();
    const n = normNum(collector_number);

    if (!cleanName) return PLACEHOLDER_IMG;

    const wantedName = normalizeNameForMatch(cleanName);

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
  } catch (err) {
    console.error("findImageUrl error:", err);
    return PLACEHOLDER_IMG;
  }
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
  } catch (err) {
    console.error("findPrices error:", err);
    return { usd: null, eur: null };
  }
}

/* ---------------- OPENAI ---------------- */

async function detectCardsWithOpenAI(imageBase64) {
  if (!OPENAI_API_KEY) {
    throw new Error("missing_openai_api_key");
  }

  const body = {
    model: OPENAI_MODEL,
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
  };

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const rawText = await openaiRes.text();

  if (!openaiRes.ok) {
    throw new Error(`openai_http_${openaiRes.status}: ${rawText}`);
  }

  const json = safeJsonParse(rawText);
  if (!json) {
    throw new Error(`openai_non_json_response: ${rawText}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`openai_no_content: ${rawText}`);
  }

  return content;
}

function parseDetectedCards(rawText) {
  const cleaned = extractJsonBlock(rawText);

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
            : Number(c?.confidence || 0)
      }))
      .filter((c) => c.name);
  }

  if (Array.isArray(parsed)) {
    return parsed
      .map((c) => ({
        name: String(c?.name || "").trim(),
        set: String(c?.set || "").trim(),
        collector_number: String(c?.collector_number || "").trim(),
        confidence:
          typeof c?.confidence === "number"
            ? c.confidence
            : Number(c?.confidence || 0)
      }))
      .filter((c) => c.name);
  }

  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !l.startsWith("{") &&
        !l.startsWith("}") &&
        !l.startsWith("[") &&
        !l.startsWith("]")
    );

  return lines.slice(0, 9).map((line) => ({
    name: line.replace(/^[-•\d.\s]+/, "").trim(),
    set: "",
    collector_number: "",
    confidence: 0.4
  })).filter((c) => c.name);
}

/* ---------------- RUTAS ---------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    hasPokemonKey: Boolean(POKEMON_API_KEY)
  });
});

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "missing_image" });
    }

    const rawText = await detectCardsWithOpenAI(imageBase64);
    const cards = parseDetectedCards(rawText);

    if (!cards.length) {
      return res.json({
        cards: [],
        warning: "no_cards_detected",
        raw: rawText
      });
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
        price_eur: prices.eur
      });
    }

    return res.json({ cards: result });
  } catch (err) {
    console.error("SCAN ERROR FULL:", err);

    return res.status(500).json({
      error: "scan_failed",
      detail: String(err?.message || err)
    });
  }
});

/* ---------------- SERVER ---------------- */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
