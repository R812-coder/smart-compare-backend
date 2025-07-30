// server.js ------------------------------------------------
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import Stripe from "stripe";
import OpenAI from "openai";
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config();                                 // load .env

/* ---------- Init ---------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client  = new MongoClient(process.env.MONGO_URI);
await client.connect();
console.log("✅ Connected to MongoDB Atlas");

const db          = client.db();
const users       = db.collection("users");
const collections = db.collection("collections");
const priceSnaps  = db.collection("price_snapshots");
const reviews     = db.collection("review_cache");

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ---------- Static ---------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------- CLOUD COLLECTIONS ---------- */

/* Save / overwrite a board ------------------------------------
   body: { email, name, products:[{asin,title,price,img}], _id? }
---------------------------------------------------------------*/
app.post("/collections", async (req, res) => {
  try {
    const { email, name, products, _id } = req.body;
    if (!email || !name || !products?.length)
      return res.status(400).json({ error: "Missing fields" });

    const doc = { email, name, products, updatedAt: new Date(), createdAt: new Date() };
    if (_id) {                    // overwrite (rename / re-save)
      await collections.updateOne({ _id: new ObjectId(_id), email }, { $set: doc });
      return res.json({ ok: true });
    }
    await collections.insertOne(doc);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB write failed" });
  }
});

/* Get all boards for user ------------------------------------*/
app.get("/collections", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email required" });
    const list = await collections
      .find({ email })
      .project({ email: 0 })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB read failed" });
  }
});

/* Delete ------------------------------------------------------*/
app.delete("/collections/:id", async (req, res) => {
  try {
    await collections.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Delete failed" });
  }
});

/* ---------- Stripe Webhook (raw) ---------- */
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const email = s.customer_details?.email || s.customer_email;
      await users.updateOne(
        { _id: s.customer },
        { $set: { email, isPremium: true, subscribedAt: new Date() } },
        { upsert: true }
      );
      console.log("💾 Premium stored for", email);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook verify fail:", e.message);
    res.status(400).send(`Webhook Error`);
  }
});

/* ---------- JSON / CORS ---------- */
app.use(cors());
app.use(express.json());

/* ---------- AI ROUTES ---------- */
app.post("/ask", async (req, res) => {
  const products = req.body.products ?? [];
  if (!products.length) return res.status(400).json({ error: "No products" });

  const prompt = `You're an expert online shopping assistant.\n\n${products
    .map(
      (p, i) =>
        `Product ${i + 1}:\nTitle: ${p.title}\nPrice:$${p.price}\nDescription:${
          p.description || "N/A"
        }`
    )
    .join("\n\n")}`;

  const gpt = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7
  });
  res.json({ answer: gpt.choices[0].message.content.trim() });
});

/* concise advantage tag */
app.post("/insight", async (req, res) => {
  const { product } = req.body;
  if (!product?.title) return res.status(400).json({ error: "product needed" });

  const prompt = `
Return ONE short tag (≤3 words) showing the key selling point, e.g. "Best Value", "$20 Cheaper", "Ergonomic Support".
Respond ONLY with the tag.

Title:${product.title}
Price:$${product.price}
Description:${product.description || "N/A"}`;

  const gpt = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4
  });
  res.json({ tag: gpt.choices[0].message.content.trim() });
});

/* pros / cons JSON */
app.post("/proscons", async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: "No product" });

  const prompt = `
Return JSON exactly like:
{"pros":["…","…"],"cons":["…","…"]}

Title:${product.title}
Description:${product.description || "N/A"}
`;

  const gpt = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5
  });
  res.json(JSON.parse(gpt.choices[0].message.content));
});

/* -------- Price Tracker -------- */
app.post("/price-snapshot", async (req, res) => {
  const { asin, price } = req.body;
  if (!asin) return res.status(400).json({ error: "asin needed" });
  await priceSnaps.insertOne({ asin, price, ts: new Date() });
  res.json({ ok: true });
});

app.get("/price-delta", async (req, res) => {
  const { asin, priceNow } = req.query;
  if (!asin || !priceNow) return res.status(400).json({ error: "params" });

  const last = await priceSnaps.find({ asin }).sort({ ts: -1 }).limit(1).toArray();
  const prev = last[0]?.price ?? priceNow;
  res.json({ prevPrice: prev, delta: (priceNow - prev).toFixed(2) });
});

/* -------- Review intelligence -------- */
app.post("/review-analyze", async (req, res) => {
  const { asin, html } = req.body;
  if (!asin || !html) return res.status(400).json({ error: "asin & html" });

  const cached = await reviews.findOne({ _id: asin });
  if (cached) return res.json(cached.data);

  const prompt = `
Extract JSON ONLY:
{"trustScore":99,"topPros":["…","…"],"topCons":["…","…"],"summary":"…"}

HTML reviews:
${html.slice(0, 12000)}`;

  const gpt  = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });
  const data = JSON.parse(gpt.choices[0].message.content);
  await reviews.insertOne({ _id: asin, data, ts: new Date() });
  res.json(data);
});
// --- get cached review intelligence ---
app.get("/review-intel", async (req, res) => {
  const { asin } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  const cached = await reviews.findOne({ _id: asin });
  if (!cached) return res.json({ trustScore: null });
  res.json(cached.data);              // {trustScore, summary, topPros, topCons, ...}
});

/* -------- Cloud collections -------- */
app.post("/save-collection", async (req, res) => {
  const { email, products } = req.body;
  if (!email || !products?.length) return res.status(400).json({ error: "missing" });
  const result = await collections.insertOne({ email, products, createdAt: new Date() });
  res.json({ id: result.insertedId });
});

app.get("/get-collections", async (req, res) => {
  const data = await collections.find({ email: req.query.email }).sort({ createdAt: -1 }).toArray();
  res.json({ collections: data });
});
const collections = db.collection("collections");
/* ensure idx for fast lookup */
await collections.createIndex({ email: 1, createdAt: -1 });

/* -------- Checkout helper -------- */
app.post("/create-checkout-session", async (_req, res) => {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: "price_1Rp7jiC5LRmF3JAD722KSrhK", quantity: 1 }],
    success_url: "https://smart-compare-backend.onrender.com/success.html",
    cancel_url:  "https://smart-compare-backend.onrender.com/cancel.html"
  });
  res.json({ url: session.url });
});


/* ---------- AI Shopping Concierge (robust) ---------------------- */
app.post("/concierge", async (req, res) => {
  const { query, products = [] } = req.body;
  if (!query || !products.length) return res.json({ ranked: [] });

  const prompt = `
You are a shopping concierge. Rank these products BEST → WORST for the request below.
Return ONLY a JSON array of ASINs in order. No other text.

User request: "${query}"

Products:
${products.map(p => `• ${p.asin} – ${p.title} – $${p.price}`).join("\n")}
`.trim();

  let ranked = [];

  try {
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });

    let raw = gpt.choices[0].message.content.trim();

    /* strip ```json … ``` or ``` … ``` fences if present */
    raw = raw.replace(/```(?:json)?|```/g, "").trim();

    /* primary parse */
    ranked = JSON.parse(raw);

  } catch (err) {
    console.error("Concierge JSON parse error:", err.message);

    /* fallback: pull every 10‑char token that looks like an ASIN */
    ranked = [...new Set((req.body.products || []).map(p => p.asin))];
  }

  res.json({ ranked });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅  Server running on", PORT));

