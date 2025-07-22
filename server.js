
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/ask", async (req, res) => {
  const products = req.body.products;
  if (!products || !products.length) {
    return res.status(400).json({ error: "No products provided." });
  }

  // 🎯 Smarter, short-and-punchy AI prompt
  const prompt = `You're an expert online shopping assistant. Compare the following products and pick the best one based on value, features, and usefulness. Focus on practicality and be concise. End with a short recommendation.

${products.map((p, i) =>
  `Product ${i + 1}:
Title: ${p.title}
Price: $${p.price}
Description: ${p.description || "No description"}`).join("\n\n")}

Give a clear, short answer in 2-3 sentences.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    res.json({ answer: response.choices[0].message.content.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OpenAI API error" });
  }
});

app.get("/", (req, res) => res.send("Smart Compare AI Backend is running!"));

app.listen(3000, () => console.log("Server running on port 3000"));
// ADD TO YOUR EXISTING server.js FILE

app.post("/insight", async (req, res) => {
  const product = req.body.product;
  if (!product) {
    return res.status(400).json({ error: "No product provided." });
  }

  const prompt = `You're a shopping assistant. Based on the product description below, generate a short, punchy 1-line tag highlighting a useful or standout feature (e.g., 'Great for posture', 'Space-saving design', 'Stylish and durable'). Be concise and helpful.

Title: ${product.title}
Price: $${product.price}
Description: ${product.description || "No description"}

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

