const axios = require('axios');
const { SYSTEM_PROMPT } = require('./prompts');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemma-4-31b-it:free';

// Builds the final system prompt by injecting this business's settings
// and the bot's own notes about this specific conversation.
function buildSystemPrompt(businessSettings, notes) {
  let prompt = SYSTEM_PROMPT;

  const settingsEntries = Object.entries(businessSettings || {});
  if (settingsEntries.length > 0) {
    const settingsText = settingsEntries
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
    prompt += `\n\nBUSINESS SETTINGS (follow these rules for this business):\n${settingsText}`;
  }

  if (notes && notes.length > 0) {
    const notesText = notes.map(n => `- ${n.note}`).join('\n');
    prompt += `\n\nYOUR OWN NOTES ABOUT THIS CONVERSATION SO FAR:\n${notesText}`;
  }

  return prompt;
}

// context = { businessSettings, notes, recentMessages }
async function processMessage(context, text, mediaUrl = null) {
  const { businessSettings, notes, recentMessages } = context;

  const systemPrompt = buildSystemPrompt(businessSettings, notes);

  const history = (recentMessages || []).map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.content,
  }));

  const userContent = mediaUrl
    ? (text ? `[Customer sent an image with caption: "${text}"]` : `[Customer sent an image — no caption]`)
    : text;

  try {
    const response = await axios.post(
      OPENROUTER_URL,
      {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: userContent },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawText = response.data.choices?.[0]?.message?.content?.trim() || '';

    try {
      // Strip markdown fences if the model wraps its JSON in them anyway
      const cleaned = rawText.replace(/^```json\s*|```$/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        reply: parsed.reply || "Thanks for your message — let me get back to you shortly.",
        action: parsed.action || 'NONE',
        action_reason: parsed.action_reason || null,
        owner_summary: parsed.owner_summary || null,
        save_note: parsed.save_note || null,
      };
    } catch (parseErr) {
      console.error('Failed to parse model response as JSON:', rawText);
      return {
        reply: rawText || "Thanks for your message — let me get back to you shortly.",
        action: 'NONE',
        action_reason: null,
        owner_summary: null,
        save_note: null,
      };
    }
  } catch (err) {
    console.error('Error calling OpenRouter:', err.response?.data || err.message);
    return {
      reply: "Sorry, I'm having trouble responding right now — someone will follow up shortly.",
      action: 'NONE',
      action_reason: null,
      owner_summary: null,
      save_note: null,
    };
  }
}

module.exports = { processMessage };
