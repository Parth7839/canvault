const BASE = "https://generativelanguage.googleapis.com/v1beta";
const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

const PROMPT = `You are an expert catalogue assistant for an energy drink can collection (mostly Monster Energy, but any brand is possible).
Look carefully at the photo. Read ALL the text printed on the can (brand, product line, flavor name, edition, country, any collab or athlete name) and identify the exact can.
Fill every field. Never leave a field empty: if you are unsure, give your best guess and lower the confidence.
- name: full product name, e.g. "Monster Ultra Paradise"
- line: product line, e.g. Ultra, Juice, Rehab, Java, Original, Zero Sugar
- edition: special edition, country, collab or athlete if visible, otherwise a short note like "Standard"
- rarity: one of Common, Uncommon, Rare, Epic, Legendary.
  Common = current mainstream flavor. Uncommon = seasonal or regional release. Rare = discontinued or limited run. Epic = athlete signature, collab or very limited. Legendary = prototype, vintage or extremely scarce.
- price: realistic value of ONE can in Indian rupees (INR) for a buyer in India, as a plain number with no symbol. About 125-150 for a common current can sold in India, higher for imported or collectible cans.
- notes: one short interesting sentence about this can.
- confidence: 0-100, how sure you are of the identification.
If the photo does not show a can at all, set name to "Unknown", confidence to 0, and price to 0.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    line: { type: "STRING" },
    edition: { type: "STRING" },
    rarity: { type: "STRING", enum: RARITIES },
    price: { type: "NUMBER" },
    notes: { type: "STRING" },
    confidence: { type: "INTEGER" }
  },
  required: ["name", "line", "edition", "rarity", "price", "notes", "confidence"]
};

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
  try {
    if (req.method === "GET") {
      await callGemini(key, [{ text: "Reply with the word OK" }], false);
      return res.status(200).json({ ok: true, model: found });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec((body && body.image) || "");
    if (!m) return res.status(400).json({ error: "Bad image" });
    const j = await callGemini(key, [{ text: PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }], true);
    if (j.promptFeedback && j.promptFeedback.blockReason) {
      return res.status(422).json({ error: "Image was blocked: " + j.promptFeedback.blockReason });
    }
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");
    const hit = text.match(/\{[\s\S]*\}/);
    if (!hit) return res.status(502).json({ error: "The AI returned no details. Try again with a clearer photo." });
    const o = JSON.parse(hit[0]);
    const out = {
      name: String(o.name || "Unknown can").trim(),
      line: String(o.line || "").trim(),
      edition: String(o.edition || "").trim(),
      rarity: RARITIES.includes(o.rarity) ? o.rarity : "Common",
      price: Math.max(0, Math.round(Number(String(o.price).replace(/[^\d.]/g, "")) || 0)),
      notes: String(o.notes || "").trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)))
    };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
};
