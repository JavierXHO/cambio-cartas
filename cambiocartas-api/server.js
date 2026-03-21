import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

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

/* ================= ARCHIVOS ================= */

const DATA_DIR = path.join(process.cwd(), "data");
const CARDS_FILE = path.join(DATA_DIR, "cards.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(CARDS_FILE)) fs.writeFileSync(CARDS_FILE, "[]");
  if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, "[]");
}

function readFile(file) {
  ensureFiles();
  return JSON.parse(fs.readFileSync(file, "utf8") || "[]");
}

function writeFile(file, data) {
  ensureFiles();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ================= UTIL ================= */

function normNum(n) {
  return String(n || "").split("/")[0].replace(/[^\d]/g, "");
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ================= POKEMON ================= */

async function pokemonFetch(url) {
  const headers = {};
  if (POKEMON_API_KEY) headers["X-Api-Key"] = POKEMON_API_KEY;

  const res = await fetch("https://api.pokemontcg.io/v2" + url, { headers });
  if (!res.ok) throw new Error("pokemon_api_error");

  return res.json();
}

async function findCard(name) {
  const data = await pokemonFetch(`/cards?q=name:"${name}"&pageSize=5`);
  return data.data?.[0] || null;
}

/* ================= SCAN ================= */

app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "no_image" });

    // ⚠️ versión simplificada (sin OpenAI para evitar fallos)
    return res.json({
      cards: [
        {
          name: "Carta detectada",
          set: "",
          collector_number: "",
          confidence: 0.5,
          image_url: PLACEHOLDER_IMG,
          price_usd: null,
          price_eur: null
        }
      ]
    });

  } catch (err) {
    res.status(500).json({ error: "scan_failed" });
  }
});

/* ================= PUBLICAR ================= */

app.post("/api/publish", (req, res) => {
  try {
    const { cards } = req.body;
    if (!Array.isArray(cards)) return res.status(400).json({ error: "no_cards" });

    const current = readFile(CARDS_FILE);

    const newCards = cards.map(c => ({
      id: makeId(),
      name: c.name,
      set: c.set,
      collector_number: c.collector_number,
      confidence: c.confidence,
      image_url: c.image_url,
      price_usd: c.price_usd,
      price_eur: c.price_eur,
      user_price: c.user_price,
      estado: c.estado,
      created_at: new Date().toISOString(),
      active: true
    }));

    writeFile(CARDS_FILE, [...current, ...newCards]);

    res.json({ ok: true });

  } catch {
    res.status(500).json({ error: "publish_error" });
  }
});

/* ================= CATALOGO ================= */

app.get("/api/cards", (req, res) => {
  try {
    const cards = readFile(CARDS_FILE);
    res.json({ cards });
  } catch {
    res.status(500).json({ error: "read_error" });
  }
});

/* ================= MENSAJES ================= */

app.post("/api/interes", (req, res) => {
  try {
    const { name, email, message, card_name } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "missing_data" });
    }

    const messages = readFile(MESSAGES_FILE);

    const newMsg = {
      id: makeId(),
      name,
      email,
      message,
      card_name,
      created_at: new Date().toISOString()
    };

    messages.push(newMsg);
    writeFile(MESSAGES_FILE, messages);

    res.json({ ok: true });

  } catch {
    res.status(500).json({ error: "save_error" });
  }
});

app.get("/api/interes", (req, res) => {
  try {
    const messages = readFile(MESSAGES_FILE);
    res.json({ messages });
  } catch {
    res.status(500).json({ error: "read_error" });
  }
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
