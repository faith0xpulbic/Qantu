const axios = require('axios');
const { SYSTEM_PROMPT } = require('./prompts');

// Guaranteed cleanup, independent of whether the model follows the prompt
// instruction. Strips dashes and brackets/parentheses since these read as
// obviously AI-written and models don't always avoid them reliably.
function cleanReply(text) {
  if (!text) return text;
  return text
    .replace(/[-–—]/g, ',')        // replace dashes with a comma so sentences still read naturally
    .replace(/[()[\]{}]/g, '')     // strip all bracket types entirely
    .replace(/,\s*,/g, ',')        // clean up any accidental double commas from the dash replacement
    .replace(/\s{2,}/g, ' ')       // collapse extra spaces left behind
    .trim();
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-3.6-flash';

// Exact schema Gemini is constrained to follow — this is stronger than
// Groq's json_object mode since Gemini enforces field types and required
// fields at the decoding level, not just "valid JSON somehow".
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['NONE', 'PING_OWNER', 'HANDOFF'] },
    action_reason: { type: 'string', nullable: true },
    owner_summary: { type: 'string', nullable: true },
    save_note: { type: 'string', nullable: true },
  },
  required: ['reply', 'action'],
};

// Builds the final system prompt by injecting this business's settings,
// its factual knowledge, and the bot's own notes about this conversation.
function buildSystemPrompt(businessSettings, businessKnowledge, notes) {
  let prompt = SYSTEM_PROMPT;

  const settingsEntries = Object.entries(businessSettings || {});
  if (settingsEntries.length > 0) {
    const settingsText = settingsEntries
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
    prompt += `\n\nBUSINESS SETTINGS (follow these rules for this business):\n${settingsText}`;
  }

  if (businessKnowledge && businessKnowledge.length > 0) {
    const knowledgeText = businessKnowledge
      .map(k => `[${k.category}]\n${k.content}`)
      .join('\n\n');
    prompt += `\n\nBUSINESS INFORMATION (use this to answer customer questions accurately):\n${knowledgeText}`;
  }

  if (notes && notes.length > 0) {
    const notesText = notes.map(n => `- ${n.note}`).join('\n');
    prompt += `\n\nYOUR OWN NOTES ABOUT THIS CONVERSATION SO FAR:\n${notesText}`;
  }

  return prompt;
}

// Formats a time gap between two messages into a short, natural marker.
// Only returned for gaps large enough to matter.
function formatGap(previousTimestamp, currentTimestamp) {
  if (!previousTimestamp) return null;

  const diffMs = new Date(currentTimestamp) - new Date(previousTimestamp);
  const diffMinutes = diffMs / (1000 * 60);
  const diffHours = diffMinutes / 60;
  const diffDays = diffHours / 24;

  if (diffMinutes < 30) return null;
  if (diffHours < 24) return `[${Math.round(diffHours)} hour(s) later]`;
  if (diffDays < 7) return `[${Math.round(diffDays)} day(s) later]`;
  return `[over a week later]`;
}

// context = { businessSettings, businessKnowledge, notes, recentMessages }
async function processMessage(context, text, mediaUrl = null) {
  const { businessSettings, businessKnowledge, notes, recentMessages } = context;

  const systemPrompt = buildSystemPrompt(businessSettings, businessKnowledge, notes);

  // Gemini's format: each turn is a 'content' object with role 'user' or
  // 'model' (not 'assistant'), and text lives inside a 'parts' array.
  const history = [];
  let previousTimestamp = null;

  for (const m of (recentMessages || [])) {
    const gapMarker = formatGap(previousTimestamp, m.created_at);
    const role = m.role === 'customer' ? 'user' : 'model';

    if (gapMarker) {
      // Gemini has no 'system' role mid-conversation, so we fold gap
      // markers into the message content itself instead.
      history.push({ role, parts: [{ text: `${gapMarker} ${m.content}` }] });
    } else {
      history.push({ role, parts: [{ text: m.content }] });
    }
    previousTimestamp = m.created_at;
  }

  const userContent = mediaUrl
    ? (text ? `[Customer sent an image with caption: "${text}"]` : `[Customer sent an image — no caption]`)
    : text;

  try {
    const response = await axios.post(
      `${GEMINI_URL}/${MODEL}:generateContent`,
      {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          ...history,
          { role: 'user', parts: [{ text: userContent }] },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.7,
        },
      },
      {
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    try {
      const parsed = JSON.parse(rawText);

      return {
        reply: cleanReply(parsed.reply) || "Thanks for your message, let me get back to you shortly.",
        action: parsed.action || 'NONE',
        action_reason: parsed.action_reason || null,
        owner_summary: parsed.owner_summary || null,
        save_note: parsed.save_note || null,
      };
    } catch (parseErr) {
      console.error('Failed to parse Gemini response as JSON:', rawText);
      return {
        reply: cleanReply(rawText) || "Thanks for your message, let me get back to you shortly.",
        action: 'NONE',
        action_reason: null,
        owner_summary: null,
        save_note: null,
      };
    }
  } catch (err) {
    console.error('Error calling Gemini:', err.response?.data || err.message);
    return {
      reply: "Sorry, I'm having trouble responding right now, someone will follow up shortly.",
      action: 'NONE',
      action_reason: null,
      owner_summary: null,
      save_note: null,
    };
  }
}

module.exports = { processMessage };
