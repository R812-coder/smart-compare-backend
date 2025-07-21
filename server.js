const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Configuration, OpenAIApi } = require("openai");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

app.post("/ask", async (req, res) => {
  const products = req.body.products;
  if (!products || !products.length) {
    return res.status(400).json({ error: "No products provided." });
  }

  const prompt = `Compare these products and suggest which one is the best value and why. Provide clear but short advice.\n\n${products
    .map((p, i) =>
      \`Product \${i + 1}:\nTitle: \${p.title}\nPrice: $\${p.price}\nDescription: \${p.description || "No description"}\`
    ).join("\n\n")}`;

  try {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    res.json({ answer: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OpenAI API error" });
  }
});

app.get("/", (req, res) => res.send("Smart Compare AI Backend is running!"));

app.listen(3000, () => console.log("Server running on port 3000"));