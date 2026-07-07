import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const POKEMON_API_KEY =
  process.env.POKEMONTCG_API_KEY ||
  process.env.POKEMON_API_KEY ||
  "";

const POKEMON_API_BASE = "https://api.pokemontcg.io/v2";

if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY no está configurada");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

function cleanText(text) {
  return String(text || "").trim();
}

function cleanJsonText(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCardNumber(value) {
  return String(value || "")
    .split("/")[0]
    .replace(/[^\d]/g, "");
}

function escapePokemonQuery(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}

function getMimeTypeFromBase64(base64) {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

async function analyzeImageWithGemini(imageBase64) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY no configurada");
  }

  const mimeType = getMimeTypeFromBase64(imageBase64);

  const prompt = `
Analiza esta imagen de cartas Pokémon TCG.

Detecta todas las cartas visibles. Si es una sola carta, devuelve una sola.

Devuelve SOLO JSON válido, sin markdown, sin texto adicional.

Estructura obligatoria:

{
  "cards": [
    {
      "name": "Nombre exacto de la carta",
      "set": "Set o edición si se puede identificar",
      "collector_number": "Número de carta si se ve",
      "confidence": 0.0
    }
  ]
}

Reglas:
- No inventes cartas si no estás razonablemente seguro.
- Si no detectas cartas, devuelve {"cards":[]}
- confidence debe estar entre 0 y 1.
- Si ves el número tipo "4/102", collector_number debe ser "4".
- Si el set no se ve claro, deja set vacío.
`;

  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        text: prompt
      },
      {
        inlineData: {
          mimeType,
          data: imageBase64
        }
      }
    ]
  });

  const text = cleanJsonText(result.text || "");

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error("Gemini devolvió JSON inválido:", text);
    throw new Error("gemini_invalid_json");
  }

  return Array.isArray(parsed.cards) ? parsed.cards : [];
}

async function pokemonFetch(path) {
  const headers = {};

  if (POKEMON_API_KEY) {
    headers["X-Api-Key"] = POKEMON_API_KEY;
  }

  const response = await fetch(POKEMON_API_BASE + path, {
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Pokemon API error:", text);
    return null;
  }

  return response.json();
}

function getUsdPrice(card) {
  const prices = card?.tcgplayer?.prices;
  if (!prices) return null;

  const possible = [
    prices.holofoil,
    prices.reverseHolofoil,
    prices.normal,
    prices["1stEditionHolofoil"],
    prices["1stEditionNormal"],
    prices.unlimitedHolofoil
  ].filter(Boolean);

  for (const price of possible) {
    const value =
      price.market ??
      price.mid ??
      price.low ??
      price.high ??
      null;

    if (value !== null && value !== undefined) {
      return safeNumber(value);
    }
  }

  return null;
}

function getEurPrice(card) {
  const prices = card?.cardmarket?.prices;
  if (!prices) return null;

  return safeNumber(
    prices.averageSellPrice ??
    prices.trendPrice ??
    prices.avg30 ??
    prices.lowPrice ??
    null
  );
}

function scorePokemonCard(candidate, detected) {
  let score = 0;

  const candidateName = String(candidate.name || "").toLowerCase();
  const detectedName = String(detected.name || "").toLowerCase();

  const candidateNumber = normalizeCardNumber(candidate.number);
  const detectedNumber = normalizeCardNumber(detected.collector_number);

  const candidateSet = String(candidate.set?.name || "").toLowerCase();
  const detectedSet = String(detected.set || "").toLowerCase();

  if (candidateName === detectedName) score += 60;
  else if (candidateName.includes(detectedName) || detectedName.includes(candidateName)) score += 35;

  if (candidateNumber && detectedNumber && candidateNumber === detectedNumber) score += 35;

  if (candidateSet && detectedSet && candidateSet.includes(detectedSet)) score += 20;

  if (candidate.images?.large || candidate.images?.small) score += 5;

  return score;
}

async function findBestPokemonCard(detected) {
  const name = cleanText(detected.name);
  const set = cleanText(detected.set);
  const number = normalizeCardNumber(detected.collector_number);

  if (!name) return null;

  const queries = [];

  if (name && number && set) {
    queries.push(`name:"${escapePokemonQuery(name)}" number:${number} set.name:"${escapePokemonQuery(set)}"`);
  }

  if (name && number) {
    queries.push(`name:"${escapePokemonQuery(name)}" number:${number}`);
  }

  if (name && set) {
    queries.push(`name:"${escapePokemonQuery(name)}" set.name:"${escapePokemonQuery(set)}"`);
  }

  queries.push(`name:"${escapePokemonQuery(name)}"`);

  let candidates = [];

  for (const q of queries) {
    const encoded = encodeURIComponent(q);
    const data = await pokemonFetch(`/cards?q=${encoded}&pageSize=20`);

    if (data?.data?.length) {
      candidates = data.data;
      break;
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    return scorePokemonCard(b, detected) - scorePokemonCard(a, detected);
  });

  return candidates[0];
}

async function enrichDetectedCard(card) {
  const detected = {
    name: cleanText(card.name),
    set: cleanText(card.set),
    collector_number: cleanText(card.collector_number),
    confidence: typeof card.confidence === "number" ? card.confidence : 0
  };

  const matched = await findBestPokemonCard(detected);

  if (!matched) {
    return {
      name: detected.name || "Carta no identificada",
      set: detected.set || "",
      collector_number: detected.collector_number || "",
      confidence: detected.confidence || 0,
      image_url: "",
      price_usd: null,
      price_eur: null,
      pokemon_id: null,
      match_source: "gemini_only"
    };
  }

  return {
    name: matched.name || detected.name || "",
    set: matched.set?.name || detected.set || "",
    collector_number: matched.number || detected.collector_number || "",
    confidence: detected.confidence || 0.6,
    image_url: matched.images?.large || matched.images?.small || "",
    price_usd: getUsdPrice(matched),
    price_eur: getEurPrice(matched),
    pokemon_id: matched.id,
    match_source: "pokemontcg"
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "CambioCartas API",
    engine: "Gemini + PokemonTCG",
    endpoints: ["/api/health", "/api/scan", "/api/search-card"]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "CambioCartas API",
    gemini: Boolean(GEMINI_API_KEY),
    gemini_model: GEMINI_MODEL,
    pokemon_api_key: Boolean(POKEMON_API_KEY)
  });
});

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        error: "no_image"
      });
    }

    const detected = await analyzeImageWithGemini(imageBase64);

    if (!detected.length) {
      return res.json({
        cards: []
      });
    }

    const enriched = [];

    for (const card of detected) {
      try {
        const result = await enrichDetectedCard(card);
        enriched.push(result);
      } catch (error) {
        console.error("Error enriqueciendo carta:", error);

        enriched.push({
          name: card.name || "Carta no identificada",
          set: card.set || "",
          collector_number: card.collector_number || "",
          confidence: card.confidence || 0,
          image_url: "",
          price_usd: null,
          price_eur: null,
          pokemon_id: null,
          match_source: "fallback"
        });
      }
    }

    return res.json({
      cards: enriched
    });

  } catch (error) {
    console.error("POST /api/scan error:", error);

    return res.status(500).json({
      error: "scan_failed",
      detail: error.message
    });
  }
});

app.get("/api/search-card", async (req, res) => {
  try {
    const name = cleanText(req.query.name);
    const set = cleanText(req.query.set);
    const collector_number = cleanText(req.query.number);

    if (!name) {
      return res.status(400).json({
        error: "missing_name"
      });
    }

    const result = await enrichDetectedCard({
      name,
      set,
      collector_number,
      confidence: 1
    });

    return res.json({
      card: result
    });

  } catch (error) {
    console.error("GET /api/search-card error:", error);

    return res.status(500).json({
      error: "search_failed",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`CambioCartas API con Gemini corriendo en puerto ${PORT}`);
});
