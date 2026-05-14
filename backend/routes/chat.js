import express from "express";
import OpenAI from "openai";

export const chatRouter = express.Router();

const SYSTEM_PROMPT = `You are a helpful PC build assistant for a PC Build Generator app.
You help users choose compatible PC components (CPU, GPU, RAM, motherboard, PSU) based on their budget and use case.
You can explain compatibility issues, suggest alternatives, and give performance expectations.
Keep responses concise and practical. Use bullet points when listing components or steps. DO NOT use markdown format.
If the user shares their current build, give specific feedback on it. Avoid answering questions not related to PC components or PC building.`;

chatRouter.post("/chat", async (req, res) => {
  // Initialize client here so dotenv has already run
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { messages, currentBuild } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: "messages array is required" });
  }

  // Validate each message has role and content
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({ ok: false, error: "Each message must have role and content" });
    }
  }

  // Build context about the user's current build if provided
  let buildContext = "";
  if (currentBuild && typeof currentBuild === "object") {
    const parts = Object.entries(currentBuild)
      .filter(([, part]) => part)
      .map(([cat, part]) => `  - ${cat.toUpperCase()}: ${part.name} ($${part.price})`)
      .join("\n");

    if (parts) {
      buildContext = `\n\nThe user's current build:\n${parts}`;
    }
  }

  const systemMessage = {
    role: "system",
    content: SYSTEM_PROMPT + buildContext,
  };

  // Set headers for SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemMessage, ...messages],
      stream: true,
      max_tokens: 1024,
      temperature: 0.7,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("OpenAI error:", error);
    // If headers already sent, send error as SSE event
    res.write(`data: ${JSON.stringify({ error: "Failed to get response from AI" })}\n\n`);
    res.end();
  }
});
