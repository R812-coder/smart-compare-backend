import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import OpenAI from "openai";

config(); // Load environment variables

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// --- AI SUGGESTION ---
app.post("/ask", async (req, res) => {
  const products = req.body.products;
  if (!products || !products.length) {
    return res.status(400).json({ error: "No products provided." });
  }

  const prompt = `You're an expert online shopping assistant... \n\n${products
    .map(
      (p, i) => `Product ${i + 1}:\nTitle: ${p.title}\nPrice: $${p.price}\nDescription: ${
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

// --- SMART INSIGHT TAG ---
app.post("/insight", async (req, res) => {
  const { product } = req.body;
  if (!product || !product.title || !product.price || !product.description) {
    return res.status(400).json({ error: "Incomplete product data." });
  }

  const prompt = `You're a shopping assistant...`;

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

// --- PROS/CONS ---
app.post("/proscons", async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: "No product provided." });

  const prompt = `Give 2 pros and 2 cons...`;

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

// --- SHORT SUMMARY ---
app.post("/summary", async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: "No product provided." });

  const prompt = `Analyze the following product...`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });

    res.json({ summary: response.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Summary fetch error:", err);
    res.status(500).json({ error: "Failed to fetch summary." });
  }
});

// --- STRIPE CHECKOUT SESSION ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: "prod_Skczs0UXzqyXw2", // Replace with your real Stripe Price ID
          quantity: 1,
        },
      ],
      success_url: "https://your-extension.com/success",
      cancel_url: "https://your-extension.com/cancel",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- DEFAULT ROUTE ---
app.get("/", (req, res) => res.send("Smart Compare AI Backend is running!"));

// --- START SERVER ---
app.listen(3000, () => {
  console.log("✅ Server running on port 3000");
});

