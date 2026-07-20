// AI is not connected yet.
// Placeholder returns a fixed response so we can test
// the full webhook → receive → send flow without needing Claude.
// Swap this out once the Anthropic API key is ready.

async function processMessage(context, text, mediaUrl = null) {
  console.log('processMessage called — AI not connected yet, using placeholder');
  // context now includes: businessSettings, notes, recentMessages —
  // available here once Claude is wired in, ignored for now.

  return {
    reply: "Hey! Got your message. Bot is online and working ✅",
    action: 'NONE',
    action_reason: null,
    owner_summary: null,
    save_note: null,
  };
}

module.exports = { processMessage };
