const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🧠 AI Suggestion (summary)
app.post("/ask", async (req, res) => {
  const products = req.body.products;
  if (!products || !products.length) {
    return res.status(400).json({ error: "No products provided." });
  }

  const prompt = `You're an expert online shopping assistant. Compare the following products and pick the best one based on value, features, and usefulness. Focus on practicality and be concise. End with a short recommendation.

${products.map((p, i) =>
  `Product ${i + 1}:
Title: ${p.title}
Price: $${p.price}
Description: ${p.description || "No description"}`
).join("\n\n")}

Give a clear, short answer in 2-3 sentences.`;

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

// 🌟 Smart Insight Tag (per product)
app.post("/insight", async (req, res) => {
  const product = req.body.product;

  if (!product || !product.title || !product.price || !product.description) {
    return res.status(400).json({ error: "Incomplete product data." });
  }

  const prompt = `You're a shopping assistant. Based on the product description below, generate a short, punchy 1-line tag highlighting a useful or standout feature (e.g., "Great for posture", "Space-saving design", "Stylish and durable"). Be concise and helpful.

Title: ${product.title}
Price: $${product.price}
Description: ${product.description}

Output just the one-line tag:`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });

    const tag = response.choices[0].message.content.trim();
    res.json({ tag });
  } catch (err) {
    console.error("Insight tag error:", err);
    res.status(500).json({ error: "Failed to fetch product insight." });
  }
});

app.get("/", (req, res) => res.send("Smart Compare AI Backend is running!"));
app.post("/proscons", async (req, res) => {
  const product = req.body.product;
  if (!product) return res.status(400).json({ error: "No product provided." });

  const prompt = `Give 2 pros and 2 cons for the following product based on its description. Be concise and useful.

Title: ${product.title}
Price: $${product.price}
Description: ${product.description}

Respond in this format:
Pros:
- ...
- ...
Cons:
- ...
- ...`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const summary = response.choices[0].message.content.trim();
    res.json({ summary });
  } catch (err) {
    console.error("Pros/Cons fetch error:", err);
    res.status(500).json({ error: "Failed to fetch pros and cons." });
  }
});

app.listen(3000, () => console.log("✅ Server running on port 3000"));
app.post("/summary", async (req, res) => {
  const product = req.body.product;
  if (!product) {
    return res.status(400).json({ error: "No product provided." });
  }

  const prompt = `Analyze the following product description. Write one pros and one cons bullet, no more than 1 line each. Be concise and helpful for shoppers.

Title: ${product.title}
Price: $${product.price}
Description: ${product.description || "No description"}

Format your answer like:
✅ [Pro text]  
❌ [Con text]`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });

    const summary = response.choices[0].message.content.trim();
    res.json({ summary });
  } catch (err) {
    console.error("Summary fetch error:", err);
    res.status(500).json({ error: "Failed to fetch summary." });
  }
});
