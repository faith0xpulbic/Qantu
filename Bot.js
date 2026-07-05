const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompts');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';

// Single function. One Claude call per message.
// Returns: { reply, action, action_reason, owner_summary }
async function processMessage(session, text, mediaUrl = null) {
  console.log('processMessage called — AI not connected yet, using placeholder');

  return {
    reply: "Hey! Got your message. Bot is online and working ✅",
    action: 'NONE',
    action_reason: null,
    owner_summary: null,
  };
}

module.exports = { processMessage };

module.exports = { processMessage };
