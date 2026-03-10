import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const POKEMON_API_KEY = process.env.POKEMON_API_KEY || "";

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

/* ---------------- RUTAS ---------------- */

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Detecta cartas Pokémon en la imagen y devuelve JSON con name, set y collector_number.",
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Detecta las cartas Pokémon." },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${imageBase64}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 500,
        }),
      }
    );

    const json = await openaiRes.json();

    let text = json?.choices?.[0]?.message?.content || "";
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { cards: [] };
    }

    const cards = parsed.cards || [];
    const result = [];

    for (const card of cards) {
      const img = await findImageUrl(card.name, card.collector_number);
      const prices = await findPrices(card.name);

      result.push({
        name: card.name || "",
        set: card.set || "",
        collector_number: card.collector_number || "",
        confidence: 0.9,
        image_url: img,
        price_usd: prices.usd,
        price_eur: prices.eur,
      });
    }

    res.json({ cards: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "scan_failed" });
  }
});

/* ---------------- START SERVER ---------------- */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
