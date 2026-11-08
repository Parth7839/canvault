const BASE = "https://generativelanguage.googleapis.com/v1beta";
const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

const PROMPT = `You are an expert catalogue assistant for a collection of canned and bottled drinks: energy drinks, sodas, juices, beers, anything.
Look carefully at the photo. Read ALL the text printed on the container (brand, product line, flavor, edition, country, any collab or athlete name) and identify the exact drink.
Fill every field. Never leave a field empty: if you are unsure, give your best guess and lower the confidence.
- brand: the brand, e.g. Monster Energy, Coca-Cola, Red Bull
- name: full product name including the brand, e.g. "Monster Ultra Paradise" or "Coca-Cola Zero Sugar"
- line: product line or variant family, e.g. Ultra, Zero Sugar, Original, Diet, Juice
- edition: special edition, country, collab or athlete if visible, otherwise a short note like "Standard"
- rarity: one of Common, Uncommon, Rare, Epic, Legendary.
  Common = current mainstream product. Uncommon = seasonal or regional release. Rare = discontinued or limited run. Epic = athlete signature, collab or very limited. Legendary = prototype, vintage or extremely scarce.
- price: realistic value of ONE container in Indian rupees (INR) for a buyer in India, as a plain number with no symbol. Roughly 20-60 for a common soft drink, 110-150 for a common energy drink, and higher for imported or collectible ones.
- notes: one short interesting sentence about this drink.
- confidence: 0-100, how sure you are of the identification.
- box: a tight bounding box around the main can or bottle in the photo, as integers from 0 to 1000 (ymin, xmin, ymax, xmax; 0,0 is the top-left corner). If you cannot see one, use 0,0,1000,1000.
If the photo does not show a drink container at all, set name to "Unknown", confidence to 0, and price to 0.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    brand: { type: "STRING" },
    name: { type: "STRING" },
    line: { type: "STRING" },
    edition: { type: "STRING" },
    rarity: { type: "STRING", enum: RARITIES },
    price: { type: "NUMBER" },
    notes: { type: "STRING" },
    confidence: { type: "INTEGER" },
    box: {
      type: "OBJECT",
      properties: { ymin: { type: "INTEGER" }, xmin: { type: "INTEGER" }, ymax: { type: "INTEGER" }, xmax: { type: "INTEGER" } }
    }
  },
  required: ["brand", "name", "line", "edition", "rarity", "price", "notes", "confidence"]
};

function cleanBox(b) {
  if (!b || typeof b !== "object") return null;
  const c = (v) => Math.max(0, Math.min(1000, Math.round(Number(v))));
  const o = { ymin: c(b.ymin), xmin: c(b.xmin), ymax: c(b.ymax), xmax: c(b.xmax) };
  if (![o.ymin, o.xmin, o.ymax, o.xmax].every(Number.isFinite)) return null;
  if (o.ymax - o.ymin < 60 || o.xmax - o.xmin < 40) return null;
  return o;
}

let found = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discover(key) {
  try {
    const r = await fetch(BASE + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    const j = await r.json();
    const names = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace("models/", ""))
      .filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n));
    names.sort((a, b) => parseFloat(b.split("-")[1]) - parseFloat(a.split("-")[1]));
    return names[0] || null;
  } catch (e) {
    return null;
  }
}

async function gen(key, model, body) {
  const r = await fetch(BASE + "/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body)
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}

async function callGemini(key, parts, json) {
  let model = process.env.GEMINI_MODEL || found || "gemini-2.5-flash";
  let rich = !!json, discovered = false, last = "";
  for (let i = 0; i < 5; i++) {
    const cfg = { temperature: 0.2 };
    if (json) cfg.responseMimeType = "application/json";
    if (rich) {
      cfg.responseSchema = SCHEMA;
      if (/2\.5/.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
    }
    const { status, j } = await gen(key, model, { contents: [{ parts }], generationConfig: cfg });
    if (status === 200) { found = model; return j; }
    last = (j.error && j.error.message) || "HTTP " + status;
    if (status === 429 || status >= 500) { await sleep(1500 * (i + 1)); continue; }
    if (status === 404 && !discovered) {
      discovered = true;
      const m = await discover(key);
      if (m && m !== model) { model = m; continue; }
    }
    if (status === 400 && rich) { rich = false; continue; }
    break;
  }
  throw new Error(last || "Scan failed");
}

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel" });
  const need = process.env.APP_PASSCODE;
  if (need && req.headers["x-passcode"] !== need) return res.status(401).json({ error: "Wrong or missing passcode. Set it in More." });
  try {
    if (req.method === "GET") {
      await callGemini(key, [{ text: "Reply with the word OK" }], false);
      return res.status(200).json({ ok: true, model: found });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec((body && body.image) || "");
    let reqParts;
    if (body && typeof body.text === "string" && body.text.trim()) {
      reqParts = [{ text: PROMPT + "\n\nThere is no photo. Instead, identify the drink from this entry and fill every field (use 0,0,1000,1000 for box): " + body.text.slice(0, 300) }];
    } else if (m) {
      reqParts = [{ text: PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }];
    } else {
      return res.status(400).json({ error: "Bad image" });
    }
    const j = await callGemini(key, reqParts, true);
    if (j.promptFeedback && j.promptFeedback.blockReason) {
      return res.status(422).json({ error: "Image was blocked: " + j.promptFeedback.blockReason });
    }
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");
    const hit = text.match(/\{[\s\S]*\}/);
    if (!hit) return res.status(502).json({ error: "The AI returned no details. Try again with a clearer photo." });
    const o = JSON.parse(hit[0]);
    const out = {
      brand: String(o.brand || "").trim(),
      name: String(o.name || "Unknown can").trim(),
      line: String(o.line || "").trim(),
      edition: String(o.edition || "").trim(),
      rarity: RARITIES.includes(o.rarity) ? o.rarity : "Common",
      price: Math.max(0, Math.round(Number(String(o.price).replace(/[^\d.]/g, "")) || 0)),
      notes: String(o.notes || "").trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0))),
      box: cleanBox(o.box)
    };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
};
