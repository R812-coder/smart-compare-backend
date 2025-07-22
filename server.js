
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
