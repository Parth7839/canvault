const PROMPT = `You are cataloguing an energy drink can collection (mostly Monster Energy). Look at the photo and reply with ONLY a JSON object, no other text:
{"name":"full flavor name e.g. Ultra Paradise","line":"product line e.g. Ultra, Juice, Rehab, Java, Original","edition":"special edition, country or collab if visible else empty","rarity":"Common|Uncommon|Rare|Epic|Legendary","price":number,"notes":"one short sentence of interesting detail","confidence":0-100}
Rarity guide: Common = current mainstream flavor; Uncommon = seasonal or regional release; Rare = discontinued or limited run; Epic = athlete signature, collab or very limited; Legendary = prototype, vintage or extremely scarce.
price = realistic USD value of ONE can: about 2-3 for common current cans, higher for collectible ones. If it is not a can, use name "Unknown" and confidence 0.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  try {
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec((req.body && req.body.image) || "");
    if (!m) return res.status(400).json({ error: "Bad image" });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      }
    );
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "Scan failed" });
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || "").join("");
    res.status(200).json(JSON.parse(text.match(/\{[\s\S]*\}/)[0]));
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
