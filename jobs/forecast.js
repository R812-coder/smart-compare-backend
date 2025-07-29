// /jobs/forecast.js  (node 18+)
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();
const snaps = db.collection("price_snapshots");
const forecasts = db.collection("price_forecasts");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);

const asins = await snaps.distinct("asin");        // every tracked product
for (const asin of asins) {
  const rows = await snaps
    .find({ asin, ts: { $gte: cutoff } })
    .sort({ ts: 1 })
    .toArray();

  if (rows.length < 8) continue;                   // need at least 8 data‑points

  const series = rows.map(r => ({ date: r.ts.toISOString().slice(0,10), price: r.price }));
  const prompt = `
You are a pricing analyst. Given the last 30 days of Amazon prices, estimate
the probability (0‑100 %) the price will drop at least 5 % within the next 7 days.
Return JSON: {"prob": <int>, "delta7d": <float>}
Prices: ${JSON.stringify(series)}
`;

  try {
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });
    const data = JSON.parse(gpt.choices[0].message.content);

    await forecasts.updateOne(
      { asin },
      { $set: { ...data, series, ts: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.error("forecast fail", asin, e.message);
  }
}
if (data.prob >= 60) {
  const users = await db.collection("users").find({ isPremium: true }).toArray();
  // loop over users with that asin in any collection and push a browser notification
}

await client.close();
