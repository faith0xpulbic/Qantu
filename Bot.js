const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompts');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';

// Single function. One Claude call per message.
// Returns: { reply, action, action_reason, owner_summary }
async function processMessage(session, latestMessage, mediaUrl = null) {
  // Build conversation history in Claude's expected format
  const history = session.messages.map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.content,
  }));

  // Build the latest user message — could be text, image, or both
  let userContent;

  if (mediaUrl) {
    // Customer sent an image (e.g. payment screenshot)
    // We describe the context rather than fetching the image URL directly,
    // since Meta image URLs require auth. The conversation context tells Claude enough.
    userContent = latestMessage
      ? `[Customer sent an image with caption: "${latestMessage}"]`
      : `[Customer sent an image — no caption]`;
  } else {
    userContent = latestMessage;
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [
      ...history,
      { role: 'user', content: userContent },
    ],
  });

  const rawText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  try {
    const parsed = JSON.parse(rawText);

    // Validate the shape — default to NONE if anything is missing
    return {
      reply: parsed.reply || "Thanks for your message — let me get back to you shortly.",
      action: parsed.action || 'NONE',
      action_reason: parsed.action_reason || null,
      owner_summary: parsed.owner_summary || null,
    };
  } catch (err) {
    console.error('Failed to parse Claude response as JSON:', rawText);

    // Fallback — treat the raw text as a plain reply, no action
    return {
      reply: rawText || "Thanks for your message — let me get back to you shortly.",
      action: 'NONE',
      action_reason: null,
      owner_summary: null,
    };
  }
}

module.exports = { processMessage };
