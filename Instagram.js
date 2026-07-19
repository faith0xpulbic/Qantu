const axios = require('axios');
const { getSession, updateSession, addMessage } = require('./sessions');
const { processMessage } = require('./Bot');
const { pingOwner } = require('./WhatsApp');

const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

const API_URL = `https://graph.instagram.com/v25.0/me/messages`;

async function sendInstagramMessage(recipientId, text) {
  try {
    await axios.post(
      API_URL,
      {
        recipient: { id: recipientId },
        message: { text },
      },
      {
        headers: {
          Authorization: `Bearer ${INSTAGRAM_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending Instagram message:', err.response?.data || err.message);
  }
}

async function handleIncomingInstagramMessage(body) {
  const entry = body.entry?.[0];

  // Instagram sends two different shapes for the same 'messages' field:
  // - Real DMs arrive as entry.messaging[0]
  // - Meta's dashboard Test button sends entry.changes[0].value
  // We normalize both into the same 'value' shape here.
  let value = null;

  if (entry?.messaging?.[0]) {
    value = entry.messaging[0];
  } else if (entry?.changes?.[0]?.value) {
    value = entry.changes[0].value;
  }

  if (!value || !value.message) {
    console.log('No Instagram message found in payload, skipping');
    return;
  }

  if (value.message.is_echo) return;

  const fromId = value.sender?.id;
  const text = value.message.text || null;

  const hasAttachment = value.message.attachments?.length > 0;
  const mediaUrl = hasAttachment ? value.message.attachments[0].payload?.url : null;

  if (!text && !mediaUrl) {
    console.log('Received unsupported Instagram message type, skipping');
    return;
  }

  console.log(`Instagram from ${fromId}: ${text || '[attachment]'}`);

  const sessionId = `ig_${fromId}`;
  const session = getSession(sessionId);
  updateSession(sessionId, { channel: 'instagram' });

  const customerContent = mediaUrl
    ? (text ? `[image] ${text}` : '[image]')
    : text;
  addMessage(sessionId, 'customer', customerContent);

  const result = await processMessage(session, text, mediaUrl);

  console.log(`Bot decision — action: ${result.action}`);

  await sendInstagramMessage(fromId, result.reply);
  addMessage(sessionId, 'assistant', result.reply);

  // All owner pings route to WhatsApp regardless of source channel
  if (result.action === 'PING_OWNER' && result.owner_summary) {
    await pingOwner(
      `${result.owner_summary}\n\n👉 Instagram user: ${fromId}\n📱 Channel: Instagram`
    );
    updateSession(sessionId, { status: 'awaiting_owner' });
  }

  if (result.action === 'HANDOFF' && result.owner_summary) {
    await pingOwner(
      `⚠️ *Handoff Required*\n\n${result.owner_summary}\n\n👉 Instagram user: ${fromId}\n📱 Channel: Instagram`
    );
    updateSession(sessionId, { status: 'handed_off' });
  }
}

module.exports = { sendInstagramMessage, handleIncomingInstagramMessage };
