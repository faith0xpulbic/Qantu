// Simple human-texting-cadence delay. A short reply (1-2 sentences) sends
// immediately, like someone tapping out a quick response. A longer reply
// (3+ sentences) gets a fixed delay first, since an instant multi-sentence
// reply is a common "that's an AI" tell — a real person would take a
// moment to type something that long.
//
// Deliberately simple: a fixed threshold and a fixed delay, not a per-
// character formula. Long artificial waits scaled to message length would
// undo the latency work already done elsewhere in this system.

const LONG_REPLY_SENTENCE_THRESHOLD = 2;
const LONG_REPLY_DELAY_MS = 30 * 1000;

/**
 * Rough sentence count — splits on ./!/? followed by a space or end of
 * string. Not linguistically precise, but good enough for a threshold
 * check like this one.
 */
function countSentences(text) {
  if (!text) return 0;
  const matches = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (matches) return matches.length;
  // No terminal punctuation found but there's content — count as one
  // sentence rather than zero, so a short punctuation-free reply doesn't
  // skip the check entirely by accident.
  return text.trim().length > 0 ? 1 : 0;
}

/**
 * Waits before sending, if the reply is long enough to warrant it.
 * Returns immediately (no delay) for short replies.
 */
async function delayForReply(text) {
  const sentenceCount = countSentences(text);
  if (sentenceCount > LONG_REPLY_SENTENCE_THRESHOLD) {
    console.log(`[reply-delay] ${sentenceCount} sentences — delaying ${LONG_REPLY_DELAY_MS}ms before sending`);
    await new Promise(resolve => setTimeout(resolve, LONG_REPLY_DELAY_MS));
  }
}

module.exports = { delayForReply, countSentences };
