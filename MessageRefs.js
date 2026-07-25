// Embeds a small, invisible reference marker into a message before it's
// saved to the database. The marker never appears in what's actually sent
// to WhatsApp/Instagram, it's appended only to the stored copy, so later
// the bot can read its own message history and deterministically know
// which conversation/customer a given message was about, instead of
// having to reason it out from vague context or a guessed ID.
//
// Format: <!--ref:conversation_id=abc,customer_id=xyz-->
// Chosen to look like an HTML comment specifically so it's inert and
// unlikely to ever collide with real message content.

function embedReference(text, { conversationId, customerId }) {
  const parts = [];
  if (conversationId) parts.push(`conversation_id=${conversationId}`);
  if (customerId) parts.push(`customer_id=${customerId}`);
  if (parts.length === 0) return text;
  return `${text}\n<!--ref:${parts.join(',')}-->`;
}

function extractReference(text) {
  if (!text) return null;
  const match = text.match(/<!--ref:([^>]+)-->/);
  if (!match) return null;

  const ref = {};
  for (const pair of match[1].split(',')) {
    const [key, value] = pair.split('=');
    if (key && value) ref[key] = value;
  }
  return Object.keys(ref).length > 0 ? ref : null;
}

// Strips the reference marker out of text before it's ever shown to a
// human, used when displaying/sending a message that was pulled from
// storage but reconstructed for a person to read.
function stripReference(text) {
  if (!text) return text;
  return text.replace(/\n?<!--ref:[^>]+-->/, '').trim();
}

module.exports = { embedReference, extractReference, stripReference };
