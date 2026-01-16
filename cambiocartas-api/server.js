import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const TCGDEX_BASE = "https://api.tcgdex.net/v2/en";

app.get("/api/health", (req, res) => res.json({ ok: true }));

function normalizeCollectorNumber(s) {
  if (!s) return "";
  return String(s).split("/")[0].trim();
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

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

function pickBestCandidate(candidates, localIdWanted) {
  if (!candidates.length) return null;

  if (localIdWanted) {
    const exact = candidates.find(c => String(c.localId) === String(localIdWanted));
    if (exact) return exact;

    const starts = candidates.find(c => String(c.localId).startsWith(String(localIdWanted)));
    if (starts) return starts;
  }

  return candidates[0];
}

function extractPricesFromTcgdexCard(fullCard) {
  const pricing = fullCard?.pricing || {};
  const tcg = pricing?.tcgplayer || null;
  const cm = pricing?.cardmarket || null;

  const usd =
    safeNumber(tcg?.normal?.marketPrice) ??
    safeNumber(tcg?.holofoil?.marketPrice) ??
    safeNumber(tcg?.["reverse-holofoil"]?.marketPrice) ??
    safeNumber(tcg?.normal?.midPrice) ??
    safeNumber(tcg?.holofoil?.midPrice) ??
    safeNumber(tcg?.["reverse-holofoil"]?.midPrice) ??
    null;

  const eur =
    safeNumber(cm?.trend) ??
    safeNumber(cm?.["trend-holo"]) ??
    safeNumber(cm?.avg) ??
    safeNumber(cm?.["avg-holo"]) ??
    null;

  return { price_usd: usd, price_eur: eur };
}

function extractImageUrlFromFull(fullCard) {
  const img = fullCard?.image;
  if (!img) return null;
  if (typeof img === "string") return img;
  return img.large || img.high || img.small || img.low || null;
}

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Falta imageBase64" });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY no configurada" });

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
                "{\"cards\":[{\"name\":\"\",\"set\":\"\",\"collector_number\":\"\",\"confidence\":0.0}]}\n" +
                "Reglas:\n" +
                "- confidence entre 0.0 y 1.0\n" +
                "- set: si no sabes pon \"\"\n" +
                "- collector_number: si no sabes pon \"\"\n"
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
        "Authorization": `Bearer ${apiKey}`
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

    const enriched = [];

    for (const c of cards) {
      const localIdWanted = normalizeCollectorNumber(c.collector_number);

      const candidates = await tcgdexSearchByName(c.name);
      const best = pickBestCandidate(candidates, localIdWanted);

      let tcgdex_id = null;
      let image_url = null;
      let price_usd = null;
      let price_eur = null;

      // ✅ CLAVE: si el candidato trae image, úsala ya (miniatura segura)
      if (best?.image) image_url = best.image;
      if (best?.id) tcgdex_id = best.id;

      // Intentar enriquecer con detalle (precios + mejor imagen si existe)
      if (best?.id) {
        const full = await tcgdexGetCardById(best.id);
        if (full) {
          const prices = extractPricesFromTcgdexCard(full);
          price_usd = prices.price_usd;
          price_eur = prices.price_eur;

          const imgFromFull = extractImageUrlFromFull(full);
          if (imgFromFull) image_url = imgFromFull; // preferir imagen del detalle
        }
      }

      enriched.push({
        ...c,
        tcgdex_id,
        image_url,     // ✅ SIEMPRE intentamos devolverla
        price_usd,
        price_eur
      });
    }

    return res.json({ cards: enriched });
  } catch (e) {
    return res.status(500).json({ error: "Fallo al analizar imagen" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
