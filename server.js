// server.js
// -----------------------------------------------
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import Stripe from "stripe";
import OpenAI from "openai";
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config(); // load .env

// ---------- Init ----------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
console.log("✅ Connected to MongoDB Atlas");
const users = client.db().collection("users");

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const collections = client.db().collection("collections");
const priceSnaps = client.db().collection("price_snapshots");
const reviews = client.db().collection("review_cache");
const data = JSON.parse(gpt.choices[0].message.content);
res.json(data);




// ---------- Static assets ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Stripe webhook (MUST be raw) ----------
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email   = session.customer_details?.email || session.customer_email;

    await users.updateOne(
      { _id: session.customer },
      {
        $set: {
          email,
          isPremium: true,
          subscribedAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log("💾 Premium status stored in DB for", email);
  }

  res.sendStatus(200);
});

// ---------- JSON / CORS for normal routes ----------
app.use(cors());
app.use(express.json());

// ---------- AI routes ----------
app.post("/ask", async (req, res) => {
  const products = req.body.products ?? [];
  if (!products.length) return res.status(400).json({ error: "No products provided." });

  const prompt = `You're an expert online shopping assistant.\n\n${products
    .map(
      (p, i) =>
        `Product ${i + 1}:\nTitle: ${p.title}\nPrice: $${p.price}\nDescription: ${
          p.description || "No description"
        }`
    )
    .join("\n\n")}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    res.json({ answer: response.choices[0].message.content.trim() });
  } catch (err) {
    console.error("AI suggestion error:", err);
    res.status(500).json({ error: "OpenAI API error" });
  }
});

app.post("/insight", async (req, res) => {
  const { product } = req.body;
  if (!product?.title || !product?.price || !product?.description)
    return res.status(400).json({ error: "Incomplete product data." });

  const prompt = `You are an e‑commerce assistant. Return ONE short tag (max 4 words) that highlights a notable advantage over similar products, e.g. "£20 Cheaper" or "Ergonomic Design". Use 3‑4 words max. ONLY return the tag, no extra text.

Product:
Title: ${product.title}
Price: $${product.price}
Description: ${product.description || "N/A"}`;


  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });
    res.json({ tag: response.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Insight tag error:", err);
    res.status(500).json({ error: "Failed to fetch product insight." });
  }
});

app.post("/proscons", async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: "No product provided." });

  const prompt = `
Summarize buyer sentiment for the following product.

Return JSON with two keys exactly:
pros: array[2] of short phrases
cons: array[2] of short phrases

Product title: ${product.title}
Key description: ${product.description || "N/A"}
Reviews snippet:
${product.reviews || "N/A"}
`;


  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    res.json({ summary: response.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Pros/Cons fetch error:", err);
    res.status(500).json({ error: "Failed to fetch pros and cons." });
  }
});
app.post("/price-snapshot", async (req, res) => {
  const { asin, price } = req.body;
  if (!asin || typeof price !== "number") return res.status(400).json({ error: "asin & price required" });

  await priceSnaps.insertOne({ asin, price, ts: new Date() });
  res.json({ saved: true });
});
app.get("/price-delta", async (req, res) => {
  const { asin, priceNow } = req.query;
  if (!asin || !priceNow) return res.status(400).json({ error: "asin & priceNow required" });

  const last = await priceSnaps.find({ asin }).sort({ ts: -1 }).limit(1).toArray();
  const prevPrice = last[0]?.price ?? priceNow;
  const delta = (priceNow - prevPrice).toFixed(2);
  res.json({ prevPrice, delta });
});
app.post("/review-analyze", async (req, res) => {
  const { asin, html } = req.body;          // html = raw reviews HTML (scraped by content.js)
  if (!asin || !html) return res.status(400).json({ error: "asin & html required" });

  // cache hit?
  const cached = await reviews.findOne({ _id: asin });
  if (cached) return res.json(cached.data);

  const prompt = `
Extract EXACTLY:
1) trustScore (0‑100; higher = more genuine)
2) topPros (array of 2 short phrases)
3) topCons (array of 2 short phrases)
4) summary (max 20 words)
You have raw HTML of Amazon reviews below.
Return JSON ONLY.

### REVIEWS HTML
${html.slice(0, 12000)}   <!-- cap to 12k chars to fit GPT good window -->
`;

  const gpt = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });

  const data = JSON.parse(gpt.choices[0].message.content);
  // save
  await reviews.insertOne({ _id: asin, data, ts: new Date() });

  res.json(data);
});

// ---------- Stripe checkout ----------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: "price_1Rp7jiC5LRmF3JAD722KSrhK", quantity: 1 }], // replace
      success_url: "https://smart-compare-backend.onrender.com/success.html",
      cancel_url:  "https://smart-compare-backend.onrender.com/cancel.html",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- (Optional) cross‑device unlock ----------
app.get("/user-status", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ isPremium: false });
  const user = await users.findOne({ email });
  res.json({ isPremium: !!user?.isPremium });
});

// ---------- Default route ----------
app.get("/", (_req, res) => res.send("Smart Compare AI backend is running!"));

// ---------- Start server ----------
app.post("/save-collection", async (req, res) => {
  const { email, products } = req.body;
  if (!email || !products?.length)
    return res.status(400).json({ error: "Missing email or products" });

  const doc = { email, products, createdAt: new Date() };
  const result = await collections.insertOne(doc);
  res.json({ success: true, id: result.insertedId });
});

app.listen(3000, () => console.log("✅  Server running on port 3000"));
