let text = data?.choices?.[0]?.message?.content ?? "";

// 1) Limpieza típica: quitar fences ```json ... ```
text = text
  .replace(/```json/gi, "")
  .replace(/```/g, "")
  .trim();

// 2) Intentar JSON directo
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch (e) {
  parsed = null;
}

// 3) Normalizar a lista de nombres
let names = [];

if (parsed && Array.isArray(parsed.cards)) {
  // cards puede venir como [{name:""}] o ["name"]
  names = parsed.cards.map(c => (typeof c === "string" ? c : c?.name || ""));
} else {
  // Fallback: sacar líneas (y limpiar bullets)
  names = text
    .split("\n")
    .map(s => s.replace(/^[-•\d.]+\s*/, "").trim())
    .filter(Boolean);
}

// 4) Limpieza final: quitar comillas/backticks raros y eliminar vacíos/duplicados
names = names
  .map(n => n.replace(/[`"]/g, "").trim())
  .filter(Boolean);

const unique = [...new Set(names)];

res.json({ cards: unique.map(name => ({ name })) });
