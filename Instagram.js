const axios = require('axios');
const {
  getBusinessByInstagramAccountId,
  findOrCreateCustomer,
  getOrCreateActiveConversation,
  updateConversationStatus,
  saveMessage,
  getRecentMessages,
  saveNote,
  getNotes,
  getBusinessSettings,
  getBusinessKnowledge,
} = require('./Database');
const { processMessage } = require('./Bot');
const { pingOwner, registerInstagramRelay } = require('./WhatsApp');

const API_URL = 'https://graph.instagram.com/v25.0/me/messages';

async function sendInstagramMessage(business, recipientId, text) {
  try {
    const response = await axios.post(
      API_URL,
      {
        recipient: { id: recipientId },
        message: { text },
      },
      {
        headers: {
          Authorization: `Bearer ${business.instagram_token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('Instagram send success:', JSON.stringify(response.data));
  } catch (err) {
    console.error('Error sending Instagram message:', err.response?.data || err.message);
  }
}

// Registers this file's send function with WhatsApp.js, so an owner's
// WhatsApp reply can be relayed to an Instagram customer without the two
// files needing to require() each other directly (which would be circular).
registerInstagramRelay(sendInstagramMessage);

async function handleIncomingInstagramMessage(body) {
  const entry = body.entry?.[0];
  const instagramAccountId = entry?.id;

  // Instagram sends two different shapes for the same 'messages' field:
  // - Real DMs arrive as entry.messaging[0]
  // - Meta's dashboard Test button sends entry.changes[0].value
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

  const business = await getBusinessByInstagramAccountId(instagramAccountId);
  if (!business) {
    console.error('No business found for Instagram account_id:', instagramAccountId);
    return;
  }

  const fromId = value.sender?.id;
  const text = value.message.text || null;

  const hasAttachment = value.message.attachments?.length > 0;
  const mediaUrl = hasAttachment ? value.message.attachments[0].payload?.url : null;

  if (!text && !mediaUrl) {
    console.log('Received unsupported Instagram message type, skipping');
    return;
  }

  console.log(`Instagram from ${fromId} (${business.name}): ${text || '[attachment]'}`);

  const customer = await findOrCreateCustomer(business.id, 'instagram', fromId);
  if (!customer) {
    console.error('Could not resolve customer for', fromId);
    return;
  }

  const conversation = await getOrCreateActiveConversation(business.id, customer.id, 'instagram');
  if (!conversation) {
    console.error('Could not resolve conversation for customer', customer.id);
    return;
  }

  const customerContent = mediaUrl
    ? (text ? `[image] ${text}` : '[image]')
    : text;
  await saveMessage(conversation.id, 'customer', customerContent);

  const businessSettings = await getBusinessSettings(business.id);
  const businessKnowledge = await getBusinessKnowledge(business.id);
  const notes = await getNotes(conversation.id);
  const recentMessages = await getRecentMessages(conversation.id);

  const context = { businessSettings, businessKnowledge, notes, recentMessages };
  const result = await processMessage(context, text, mediaUrl);

  console.log(`Bot decision — action: ${result.action}`);
  if (result.owner_summary) {
    console.log(`Owner summary content: ${result.owner_summary}`);
  }

  await sendInstagramMessage(business, fromId, result.reply);
  await saveMessage(conversation.id, 'assistant', result.reply);

  if (result.save_note) {
    await saveNote(conversation.id, result.save_note);
  }

  // All owner pings route to WhatsApp regardless of source channel
  if (result.action === 'PING_OWNER' && result.owner_summary) {
    await pingOwner(
      business,
      `${result.owner_summary}\n\n👉 Instagram user: ${fromId}\n📱 Channel: Instagram`
    );
    await updateConversationStatus(conversation.id, 'awaiting_owner', result.owner_summary);
  }

  if (result.action === 'HANDOFF' && result.owner_summary) {
    await pingOwner(
      business,
      `⚠️ *Handoff Required*\n\n${result.owner_summary}\n\n👉 Instagram user: ${fromId}\n📱 Channel: Instagram`
    );
    await updateConversationStatus(conversation.id, 'handed_off');
  }
}

module.exports = { sendInstagramMessage, handleIncomingInstagramMessage };
