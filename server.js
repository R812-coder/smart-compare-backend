// server.js --------------------------------------------------------
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import Stripe from "stripe";
import OpenAI from "openai";
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config();

/* ---------- Init ---------- */
const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client  = new MongoClient(process.env.MONGO_URI);
await client.connect();
console.log("✅ Connected to MongoDB Atlas");

const db          = client.db();
const users       = db.collection("users");
const collections = db.collection("collections");
const priceSnaps  = db.collection("price_snapshots");
const reviews     = db.collection("review_cache");

const app        = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ---------- Static ----------
   (success.html / cancel.html live in public/) */
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Stripe webhook (raw body) ---------- */
app.post("/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
      if (event.type === "checkout.session.completed") {
        const s     = event.data.object;
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
      res.status(400).send("Webhook error");
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

/* concise advantage‑tag */
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

/* Pros / Cons */
app.post("/proscons", async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: "No product" });

  const prompt = `
Return JSON exactly like:
{"pros":["…","…"],"cons":["…","…"]}

Title:${product.title}
Description:${product.description || "N/A"}
`;

  try {
    const gpt = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5
    });
    res.json(JSON.parse(gpt.choices[0].message.content));
  } catch (e) {
    // 🔧 failsafe so popup never crashes
    console.error("pros/cons parse error:", e.message);
    res.json({ pros: [], cons: [] });
  }
});

/* ---------- price tracker ---------- */
app.post("/price-snapshot", async (req, res) => {
  const { asin, price } = req.body;
  if (!asin) return res.status(400).json({ error: "asin needed" });
  await priceSnaps.insertOne({ asin, price, ts: new Date() });
  res.json({ ok: true });
});

app.get("/price-delta", async (req, res) => {
  const { asin, priceNow } = req.query;
  if (!asin || !priceNow) return res.status(400).json({ error: "params" });

  const last  = await priceSnaps.find({ asin }).sort({ ts: -1 }).limit(1).toArray();
  const prev  = last[0]?.price ?? priceNow;
  res.json({ prevPrice: prev, delta: (priceNow - prev).toFixed(2) });
});

/* ---------- review intelligence ---------- */
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

/* cached review intel */
app.get("/review-intel", async (req, res) => {
  const { asin } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  const cached = await reviews.findOne({ _id: asin });
  res.json(cached?.data ?? { trustScore: null });
});

/* ---------- cloud collections ---------- */
app.post("/save-collection", async (req, res) => {
  const { email, products } = req.body;
  if (!email || !products?.length) return res.status(400).json({ error: "missing" });
  const result = await collections.insertOne({ email, products, createdAt: new Date() });
  res.json({ id: result.insertedId });
});

app.get("/get-collections", async (req, res) => {
  const data = await collections
    .find({ email: req.query.email })
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ collections: data });
});

/* ---------- Stripe checkout helper ---------- */
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

/* ---------- AI Shopping Concierge (robust) ---------- */
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

  let ranked;
  try {
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });
    let raw = gpt.choices[0].message.content.trim();
    raw = raw.replace(/```(?:json)?|```/g, "").trim();     // 🔧 strip fences
    ranked = JSON.parse(raw);
  } catch (e) {
    console.warn("Concierge parse fallback:", e.message);
    ranked = products.map(p => p.asin);                   // 🔧 fallback = original order
  }

  res.json({ ranked });
});

/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;                     // 🔧 use Render port if given
app.listen(PORT, () => console.log("✅  Server running on", PORT));

import cron from "node-cron";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const db = (await new MongoClient(process.env.MONGO_URI).connect()).db();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cron.schedule("0 3 * * *", async () => {           // every night UTC 03:00
  const asins = await db.collection("price_snapshots").distinct("asin");
  for (const asin of asins) {
    const hist = await db.collection("price_snapshots")
                         .find({ asin })
                         .sort({ ts: -1 })
                         .limit(30)
                         .toArray();

    const prompt = `
Return JSON like {"prob":73,"spark":[199,195,189,180,175]}
where prob = likelihood (%) that price drops ≥5 % within 7 days.

Price history (newest→oldest): ${hist.map(h => h.price).join(",")}`;

    const raw = (await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages:[{role:"user",content:prompt}], temperature:0.2
    })).choices[0].message.content.replace(/```(?:json)?|```/g,"");

    const data = JSON.parse(raw);
    await db.collection("price_forecast").updateOne(
      { _id: asin },
      { $set: { ...data, ts: new Date() } },
      { upsert: true }
    );
  }
  console.log("✅ nightly price forecast done");
});
