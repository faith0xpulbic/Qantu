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
  getAwaitingOwnerConversations,
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

async function pingOwner(business, text, conversationId = null) {
  if (!business.owner_contact) {
    console.warn('No owner_contact set for this business — skipping owner ping');
    return;
  }
  await sendWhatsAppMessage(business, business.owner_contact, text);

  // Save this ping as a real message on the conversation, so when the
  // owner replies, the full back-and-forth (bot's ping + owner's reply)
  // is just normal conversation history, no separate summary field needed.
  if (conversationId) {
    await saveMessage(conversationId, 'owner_ping', text);
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
// Logic: find conversations still awaiting the owner. If there's exactly
// one, this reply is obviously for that one, relay it directly, no need
// to ask. If there are genuinely multiple still open, show the owner what
// each one was actually about (using the summary already sent) so they
// can just say which, in plain language, not a rigid numbered menu.
async function handleOwnerReply(business, text) {
  console.log(`Owner reply received for ${business.name}: "${text}"`);

  const pending = await getAwaitingOwnerConversations(business.id);

  if (pending.length === 0) {
    console.log('No conversations currently awaiting owner — reply logged only, nothing to relay.');
    return;
  }

  if (pending.length === 1) {
    // Only one thing waiting on the owner right now — this reply is for it.
    await relayOwnerMessageToCustomer(business, pending[0], text);
    return;
  }

  // Genuinely multiple pending — show the owner what each one was
  // actually about, pulled from the real ping message already sent,
  // not a separate stored field.
  const listItems = [];
  for (const c of pending) {
    const recent = await getRecentMessages(c.id, 5);
    const lastPing = [...recent].reverse().find(m => m.role === 'owner_ping');
    listItems.push(`${c.channel_type}: ${lastPing ? lastPing.content.split('\n')[0] : 'no context available'}`);
  }
  const list = listItems.map((item, i) => `${i + 1}. ${item}`).join('\n');
  await sendWhatsAppMessage(
    business,
    business.owner_contact,
    `I've got a few things waiting on you, which one is this about?\n${list}`
  );
}

// Sends the owner's message to the actual waiting customer, on whichever
// channel that conversation is on. Passes it through the AI so it comes
// out in Amara's natural voice rather than pasted raw, and marks the
// conversation active again since the owner has now responded.
async function relayOwnerMessageToCustomer(business, conversation, ownerText) {
  await saveMessage(conversation.id, 'owner', ownerText);

  const businessSettings = await getBusinessSettings(business.id);
  const businessKnowledge = await getBusinessKnowledge(business.id);
  const notes = await getNotes(conversation.id);
  const recentMessages = await getRecentMessages(conversation.id);

  const context = { businessSettings, businessKnowledge, notes, recentMessages };
  // Wrap the owner's message clearly so the model understands this is
  // the owner giving it information to relay, not a customer speaking.
  const promptText = `[The business owner just told you the following, relay this to the customer naturally in your own voice]: ${ownerText}`;

  const result = await processMessage(context, promptText);

  console.log(`Relaying owner reply to customer on ${conversation.channel_type}`);

  if (conversation.channel_type === 'whatsapp') {
    const whatsappChannel = conversation.customer_channels?.find(c => c.channel_type === 'whatsapp');
    if (whatsappChannel) {
      await sendWhatsAppMessage(business, whatsappChannel.channel_identifier, result.reply);
    }
  } else if (conversation.channel_type === 'instagram') {
    // Deferred to Instagram.js via a shared relay function to avoid a
    // circular import between WhatsApp.js and Instagram.js.
    if (relayToInstagram) {
      const igChannel = conversation.customer_channels?.find(c => c.channel_type === 'instagram');
      if (igChannel) {
        await relayToInstagram(business, igChannel.channel_identifier, result.reply);
      }
    } else {
      console.error('relayToInstagram not registered — cannot deliver owner reply to Instagram customer');
    }
  }

  await saveMessage(conversation.id, 'assistant', result.reply);
  await updateConversationStatus(conversation.id, 'active');
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
      conversation.id
    );
    await updateConversationStatus(conversation.id, 'awaiting_owner');
  }

  if (result.action === 'HANDOFF' && result.owner_summary) {
    await pingOwner(
      business,
      `⚠️ *Handoff Required*\n\n${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`,
      conversation.id
    );
    await updateConversationStatus(conversation.id, 'handed_off');
  }
}

module.exports = { sendWhatsAppMessage, pingOwner, handleIncomingWhatsAppMessage, registerInstagramRelay };
