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
  getConversationById,
  getConversationFullContext,
  getRecentCustomerStatuses,
} = require('./Database');
const { processMessage, processOwnerMessage } = require('./Bot');
const { embedReference, extractReference, stripReference } = require('./MessageRefs');

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

async function pingOwner(business, text, conversationId = null, customerId = null) {
  if (!business.owner_contact) {
    console.warn('No owner_contact set for this business — skipping owner ping');
    return;
  }
  await sendWhatsAppMessage(business, business.owner_contact, text);

  // Save this ping as a real message on the conversation, so when the
  // owner replies, the full back-and-forth (bot's ping + owner's reply)
  // is just normal conversation history, no separate summary field needed.
  // The stored copy also carries an invisible reference to the exact
  // conversation/customer this ping was about, so the bot can trace back
  // to the right one deterministically later, rather than guessing from
  // vague owner language.
  if (conversationId) {
    const storedText = embedReference(text, { conversationId, customerId });
    await saveMessage(conversationId, 'owner_ping', storedText);
  }
}

// Strips formatting differences (+, spaces, leading zeros) so phone number
// comparisons work regardless of how each was originally entered.
function normalizePhone(number) {
  if (!number) return '';
  return number.replace(/[^\d]/g, '').replace(/^0+/, '');
}

// Handles a message from the confirmed business owner, as distinct from
// a customer message.
//
// The AI now has real tools available (full conversation lookup, and a
// lightweight recent-status sweep), so instead of code pre-deciding which
// single conversation this relates to, we give it a short list of recent
// conversations it has personally brought to the owner's attention (with
// their IDs), and let it investigate and decide for itself: answer
// directly, relay something to a customer, or ask for clarification.
async function handleOwnerReply(business, text) {
  console.log(`Owner reply received for ${business.name}: "${text}"`);

  const recentOwnerContext = await getRecentOwnerPingSummaries(business.id);

  const businessSettings = await getBusinessSettings(business.id);
  const businessKnowledge = await getBusinessKnowledge(business.id);

  const dbFunctions = {
    getConversationFullContext,
    getRecentCustomerStatuses,
    businessId: business.id,
    sendToCustomer: async (conversationId, message) => {
      const conversation = await getConversationById(conversationId);
      if (!conversation) return false;
      await saveMessage(conversationId, 'owner', text);
      await relayMessageToCustomer(business, conversation, message);
      await saveMessage(conversationId, 'assistant', message);
      await updateConversationStatus(conversationId, 'active');
      return true;
    },
  };

  const result = await processOwnerMessage(
    { businessSettings, businessKnowledge, recentOwnerContext },
    text,
    dbFunctions
  );

  await sendWhatsAppMessage(business, business.owner_contact, result.reply);
}

// Builds a compact list of the business's most recent owner_ping messages
// across recent conversations, each tagged with its conversation_id,
// channel, and a short excerpt, so the AI automatically has real
// candidates to reason over the moment the owner messages, without
// needing to call a tool just to see what's been going on recently.
async function getRecentOwnerPingSummaries(businessId, limit = 5) {
  const recentStatuses = await getRecentCustomerStatuses(businessId, 72);
  const summaries = [];

  for (const conv of recentStatuses.slice(0, limit)) {
    const messages = await getRecentMessages(conv.conversation_id, 10);
    const lastPing = [...messages].reverse().find(m => m.role === 'owner_ping');
    if (lastPing) {
      summaries.push({
        conversation_id: conv.conversation_id,
        channel: conv.channel,
        status: conv.status,
        tags: conv.tags,
        lastPing: stripReference(lastPing.content),
      });
    }
  }

  return summaries;
}

// Relays a message to the actual customer on whichever channel their
// conversation is on. Used both by the owner-reply flow (when the AI
// decides to relay something) and available for future direct use.
async function relayMessageToCustomer(business, conversation, replyText) {
  console.log(`Relaying message to customer on ${conversation.channel_type}`);

  if (conversation.channel_type === 'whatsapp') {
    const whatsappChannel = conversation.customer_channels?.find(c => c.channel_type === 'whatsapp');
    if (whatsappChannel) {
      await sendWhatsAppMessage(business, whatsappChannel.channel_identifier, replyText);
    }
  } else if (conversation.channel_type === 'instagram') {
    if (relayToInstagram) {
      const igChannel = conversation.customer_channels?.find(c => c.channel_type === 'instagram');
      if (igChannel) {
        await relayToInstagram(business, igChannel.channel_identifier, replyText);
      }
    } else {
      console.error('relayToInstagram not registered — cannot deliver owner reply to Instagram customer');
    }
  }
}

// Instagram.js registers its send function here at startup, avoiding a
// circular require() between the two files while still letting WhatsApp.js
// relay owner replies to Instagram customers.
let relayToInstagram = null;
function registerInstagramRelay(fn) {
  relayToInstagram = fn;
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

  // Critical check: if the sender is this business's own owner_contact number,
  // this is the owner replying to a PING_OWNER, not a customer message.
  // Without this check, the owner's own number gets treated as a brand new
  // customer every time, which corrupts the conversation and triggers the
  // bot to respond to the owner as if they were asking to place an order.
  if (normalizePhone(fromNumber) === normalizePhone(business.owner_contact)) {
    console.log(`WhatsApp from ${fromNumber} (${business.name}): [OWNER REPLY] ${text || '[image]'}`);
    await handleOwnerReply(business, text);
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
  if (result.owner_summary) {
    console.log(`Owner summary content: ${result.owner_summary}`);
  }

  await sendWhatsAppMessage(business, fromNumber, result.reply);
  await saveMessage(conversation.id, 'assistant', result.reply);

  if (result.save_note) {
    await saveNote(conversation.id, result.save_note);
  }

  if (result.action === 'PING_OWNER' && result.owner_summary) {
    await pingOwner(
      business,
      `${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`,
      conversation.id,
      customer.id
    );
    await updateConversationStatus(conversation.id, 'awaiting_owner');
  }

  if (result.action === 'HANDOFF' && result.owner_summary) {
    await pingOwner(
      business,
      `⚠️ *Handoff Required*\n\n${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`,
      conversation.id,
      customer.id
    );
    await updateConversationStatus(conversation.id, 'handed_off');
  }
}

module.exports = { sendWhatsAppMessage, pingOwner, handleIncomingWhatsAppMessage, registerInstagramRelay };
