const axios = require('axios');
const {
  getBusinessByWhatsAppPhoneNumberId,
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

const API_URL = 'https://graph.facebook.com/v25.0';

async function sendWhatsAppMessage(business, toNumber, text) {
  try {
    const response = await axios.post(
      `${API_URL}/${business.whatsapp_phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${business.whatsapp_token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('WhatsApp send success:', JSON.stringify(response.data));
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response?.data || err.message);
  }
}

async function pingOwner(business, text) {
  if (!business.owner_contact) {
    console.warn('No owner_contact set for this business — skipping owner ping');
    return;
  }
  await sendWhatsAppMessage(business, business.owner_contact, text);
}

async function handleIncomingWhatsAppMessage(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const phoneNumberId = value?.metadata?.phone_number_id;

  // Ignore delivery/read status updates
  if (!message) return;

  const business = await getBusinessByWhatsAppPhoneNumberId(phoneNumberId);
  if (!business) {
    console.error('No business found for WhatsApp phone_number_id:', phoneNumberId);
    return;
  }

  const fromNumber = message.from;
  const text = message.text?.body || null;
  const mediaUrl = message.image?.id || message.document?.id || null;

  if (!text && !mediaUrl) {
    console.log('Received unsupported message type:', message.type);
    return;
  }

  console.log(`WhatsApp from ${fromNumber} (${business.name}): ${text || '[image]'}`);

  const customer = await findOrCreateCustomer(business.id, 'whatsapp', fromNumber);
  if (!customer) {
    console.error('Could not resolve customer for', fromNumber);
    return;
  }

  const conversation = await getOrCreateActiveConversation(business.id, customer.id, 'whatsapp');
  if (!conversation) {
    console.error('Could not resolve conversation for customer', customer.id);
    return;
  }

  const customerContent = mediaUrl
    ? (text ? `[image] ${text}` : '[image]')
    : text;
  await saveMessage(conversation.id, 'customer', customerContent);

  // Gather context for the bot: business rules, business info, its own notes, recent messages
  const businessSettings = await getBusinessSettings(business.id);
  const businessKnowledge = await getBusinessKnowledge(business.id);
  const notes = await getNotes(conversation.id);
  const recentMessages = await getRecentMessages(conversation.id);

  const context = { businessSettings, businessKnowledge, notes, recentMessages };
  const result = await processMessage(context, text, mediaUrl);

  console.log(`Bot decision — action: ${result.action}`);

  await sendWhatsAppMessage(business, fromNumber, result.reply);
  await saveMessage(conversation.id, 'assistant', result.reply);

  if (result.save_note) {
    await saveNote(conversation.id, result.save_note);
  }

  if (result.action === 'PING_OWNER' && result.owner_summary) {
    await pingOwner(
      business,
      `${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`
    );
    await updateConversationStatus(conversation.id, 'awaiting_owner');
  }

  if (result.action === 'HANDOFF' && result.owner_summary) {
    await pingOwner(
      business,
      `⚠️ *Handoff Required*\n\n${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`
    );
    await updateConversationStatus(conversation.id, 'handed_off');
  }
}

module.exports = { sendWhatsAppMessage, pingOwner, handleIncomingWhatsAppMessage };
