const axios = require('axios');
const { getSession, updateSession, addMessage } = require('./sessions');
const { processMessage } = require('./Bot');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OWNER_NUMBER = process.env.OWNER_WHATSAPP_NUMBER;

const API_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(toNumber, text) {
  try {
    await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response?.data || err.message);
  }
}

async function pingOwner(text) {
  if (!OWNER_NUMBER) {
    console.warn('OWNER_WHATSAPP_NUMBER not set — skipping owner ping');
    return;
  }
  await sendWhatsAppMessage(OWNER_NUMBER, text);
}

async function handleIncomingWhatsAppMessage(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  // Ignore delivery/read status updates
  if (!message) return;

  const fromNumber = message.from;
  const text = message.text?.body || null;
  const mediaUrl = message.image?.id || message.document?.id || null;

  if (!text && !mediaUrl) {
    console.log('Received unsupported message type:', message.type);
    return;
  }

  console.log(`WhatsApp from ${fromNumber}: ${text || '[image]'}`);

  const session = getSession(fromNumber);
  updateSession(fromNumber, { channel: 'whatsapp' });

  const customerContent = mediaUrl
    ? (text ? `[image] ${text}` : '[image]')
    : text;
  addMessage(fromNumber, 'customer', customerContent);

  const result = await processMessage(session, text, mediaUrl);

  console.log(`Bot decision — action: ${result.action}`);

  await sendWhatsAppMessage(fromNumber, result.reply);
  addMessage(fromNumber, 'assistant', result.reply);

  if (result.action === 'PING_OWNER' && result.owner_summary) {
    await pingOwner(
      `${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`
    );
    updateSession(fromNumber, { status: 'awaiting_owner' });
  }

  if (result.action === 'HANDOFF' && result.owner_summary) {
    await pingOwner(
      `⚠️ *Handoff Required*\n\n${result.owner_summary}\n\n👉 Customer: ${fromNumber}\n📱 Channel: WhatsApp`
    );
    updateSession(fromNumber, { status: 'handed_off' });
  }
}

module.exports = { sendWhatsAppMessage, pingOwner, handleIncomingWhatsAppMessage };
