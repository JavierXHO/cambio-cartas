import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";

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

// Cache sets 12h
let SETS_CACHE = { at: 0, data: [] };

app.get("/api/sets", async (req, res) => {
  try {
    const now = Date.now();
    if (SETS_CACHE.data.length && now - SETS_CACHE.at < 1000 * 60 * 60 * 12) {
      return res.json({ sets: SETS_CACHE.data });
    }

    const data = await pokemonFetch(`/sets?pageSize=250`);
    const sets = Array.isArray(data?.data) ? data.data : [];

    // Devolvemos solo lo necesario para el dropdown
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
    return res.status(500).json({ error: "No se pudieron cargar las ediciones" });
  }
});

// Buscar carta exacta en un set elegido
app.post("/api/lookup", async (req, res) => {
  try {
    const { setId, name, number } = req.body;

    if (!setId || !name) {
      return res.status(400).json({ error: "Falta setId o name" });
    }

    const cleanName = String(name).replace(/"/g, "").trim();
    const num = normNum(number);

    // 1) Mejor: setId + number (si hay)
    if (num) {
      const q = `set.id:${setId} number:${num}`;
      const data = await pokemonFetch(`/cards?q=${encodeURIComponent(q)}&pageSize=10`);
      const list = Array.isArray(data?.data) ? data.data : [];
      if (list.length) {
        const c = list[0];
        return res.json({
          found: true,
          card: {
            id: c.id,
            name: c.name,
            number: c.number,
            set: c.set?.name || "",
            image_small: c.images?.small || "",
            image_large: c.images?.large || ""
          }
        });
      }
    }

    // 2) Si no hay número o no encontró: setId + name
    const q2 = `set.id:${setId} name:"${cleanName}"`;
    const data2 = await pokemonFetch(`/cards?q=${encodeURIComponent(q2)}&pageSize=10`);
    const list2 = Array.isArray(data2?.data) ? data2.data : [];
    if (list2.length) {
      const c = list2[0];
      return res.json({
        found: true,
        card: {
          id: c.id,
          name: c.name,
          number: c.number,
          set: c.set?.name || "",
          image_small: c.images?.small || "",
          image_large: c.images?.large || ""
        }
      });
    }

    return res.json({ found: false });
  } catch {
    return res.status(500).json({ error: "Falló lookup" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));
