import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const POKEMON_API_KEY =
  process.env.POKEMON_API_KEY ||
  process.env.POKEMONTCG_API_KEY ||
  "";

const POKEMON_API_BASE = "https://api.pokemontcg.io/v2";

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

function getOutputText(data) {
  if (data.output_text) return data.output_text;

  let text = "";

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.text) text += content.text;
          if (content.type === "output_text" && content.text) text += content.text;
        }
      }
    }
  }

  return text;
}

async function analyzeImageWithOpenAI(imageBase64) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY no configurada");
  }

  const prompt = `
Analiza esta imagen de cartas Pokémon TCG.

Necesito que detectes todas las cartas visibles. Si es una sola carta, devuelve una sola.

Devuelve SOLO JSON válido, sin markdown, con esta estructura:

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
- Si el nombre no se ve completo, usa la mejor estimación.
- confidence debe ir entre 0 y 1.
- Si no detectas cartas, devuelve {"cards":[]}
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "high"
            }
          ]
        }
      ],
      max_output_tokens: 1800
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI error:", data);
    throw new Error(data?.error?.message || "openai_error");
  }

  const outputText = cleanJsonText(getOutputText(data));

  try {
    const parsed = JSON.parse(outputText);
    return Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch (err) {
    console.error("No se pudo parsear JSON OpenAI:", outputText);
    throw new Error("openai_invalid_json");
  }
}

async function pokemonFetch(path) {
  const headers = {};

  if (POKEMON_API_KEY) {
    headers["X-Api-Key"] = POKEMON_API_KEY;
  }

  const response = await fetch(POKEMON_API_BASE + path, { headers });

  if (!response.ok) {
    const text = await response.text();
    console.error("Pokemon API error:", text);
    return null;
  }

  return response.json();
}

function escapePokemonQuery(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
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

  for (const p of possible) {
    const value =
      p.market ??
      p.mid ??
      p.low ??
      p.high ??
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

  candidates.sort((a, b) => scorePokemonCard(b, detected) - scorePokemonCard(a, detected));

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
      match_source: "openai_only"
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
    endpoints: ["/api/health", "/api/scan", "/api/search-card"]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "CambioCartas API",
    openai: Boolean(OPENAI_API_KEY),
    pokemon_api_key: Boolean(POKEMON_API_KEY)
  });
});

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "no_image" });
    }

    const detected = await analyzeImageWithOpenAI(imageBase64);

    if (!detected.length) {
      return res.json({ cards: [] });
    }

    const enriched = [];

    for (const card of detected) {
      try {
        const result = await enrichDetectedCard(card);
        enriched.push(result);
      } catch (err) {
        console.error("Error enriqueciendo carta:", err);
        enriched.push({
          name: card.name || "Carta no identificada",
          set: card.set || "",
          collector_number: card.collector_number || "",
          confidence: card.confidence || 0,
          image_url: "",
          price_usd: null,
          price_eur: null,
          match_source: "fallback"
        });
      }
    }

    res.json({ cards: enriched });

  } catch (err) {
    console.error("POST /api/scan error:", err);
    res.status(500).json({
      error: "scan_failed",
      detail: err.message
    });
  }
});

app.get("/api/search-card", async (req, res) => {
  try {
    const name = cleanText(req.query.name);
    const set = cleanText(req.query.set);
    const collector_number = cleanText(req.query.number);

    if (!name) {
      return res.status(400).json({ error: "missing_name" });
    }

    const result = await enrichDetectedCard({
      name,
      set,
      collector_number,
      confidence: 1
    });

    res.json({ card: result });

  } catch (err) {
    console.error("GET /api/search-card error:", err);
    res.status(500).json({
      error: "search_failed",
      detail: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`CambioCartas API corriendo en puerto ${PORT}`);
});
