import { config } from "dotenv";
import { MongoClient } from "mongodb";
import OpenAI from "openai";

config();

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db         = client.db();
const snaps      = db.collection("price_snapshots");
const forecasts  = db.collection("price_forecasts");
const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const asins = await snaps.distinct("asin");

for (const asin of asins) {
  const series = await snaps
    .find({ asin })
    .sort({ ts: -1 })
    .limit(30)
    .project({ price: 1, ts: 1 })
    .toArray();

  if (series.length < 7) continue;                // need history

  const prices = series.map(p => p.price).reverse();

  const prompt = `
Historical daily prices: [${prices.join(", ")}]
Give a JSON object ONLY like:
{"probDrop":73,"dropAmt":18,"daysOut":4}
probDrop = chance price drops ≥5 % within next 7 days.
`;

  try {
    const gpt  = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });
    const data = JSON.parse(gpt.choices[0].message.content);

    await forecasts.updateOne(
      { asin },
      { $set: { asin, ...data, createdAt: new Date() } },
      { upsert: true }
    );
    console.log("🔮", asin, data.probDrop + "%");
  } catch (err) {
    console.error("forecast fail", asin, err.message);
  }
}

await client.close();
