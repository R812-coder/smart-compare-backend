// server.js --------------------------------------------------------
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import Stripe from "stripe";
import OpenAI from "openai";
import { MongoClient } from "mongodb";
import cron from "node-cron";
import { config } from "dotenv";
config();

/* ---------- Init ---------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
console.log("✅ Connected to MongoDB Atlas");

const db          = client.db();
const users       = db.collection("users");
const collections = db.collection("collections");
const priceSnaps  = db.collection("price_snapshots");
const priceFc     = db.collection("price_forecast");
const reviews     = db.collection("review_cache");

const app        = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ---------- Static ---------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Stripe webhook (raw) ---------- */
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
        const s = event.data.object;
        const email = s.customer_details?.email || s.customer_email;
        await users.updateOne(
          { _id: s.customer },
          { $set: { email, isPremium: true, subscribedAt: new Date() } },
          { upsert: true }
        );
      }
      res.sendStatus(200);
    } catch (e) {
      console.error("Webhook error:", e.message);
      res.status(400).send("Webhook error");
    }
  });

/* ---------- JSON / CORS ---------- */
app.use(cors());
app.use(express.json());

/* ---------- (existing AI / price / review routes … unchanged) ---------- */
/* … keep everything you already have here … */

/* ---------- Price‑forecast READ route ---------- */
app.get("/price-forecast", async (req, res) => {
  const { asin } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  const doc = await priceFc.findOne({ _id: asin });
  if (!doc) return res.json({ prob: null, spark: [] });
  res.json(doc);
});

/* ---------- Nightly cron (uses same db / OpenAI) ---------- */
cron.schedule("0 3 * * *", async () => {   // UTC 03:00 nightly
  const asins = await priceSnaps.distinct("asin");
  for (const asin of asins) {
    const hist = await priceSnaps.find({ asin })
                                 .sort({ ts: -1 })
                                 .limit(30)
                                 .toArray();
    if (!hist.length) continue;

    const prompt = `
Return JSON like {"prob":73,"spark":[199,195,189,180,175]}
where prob = likelihood (%) that price drops ≥5 % within 7 days.

Price history (newest→oldest): ${hist.map(h => h.price).join(",")}`.trim();

    try {
      let raw = (await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })).choices[0].message.content.trim();

      raw = raw.replace(/```(?:json)?|```/g, "").trim();
      const data = JSON.parse(raw);                 // {prob, spark[]}

      await priceFc.updateOne(
        { _id: asin },
        { $set: { ...data, ts: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.warn("Forecast fail for", asin, e.message);
    }
  }
  console.log("✅ Nightly price forecast complete");
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅  Server running on", PORT));
