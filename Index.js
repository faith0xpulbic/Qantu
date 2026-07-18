require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const { handleIncomingWhatsAppMessage } = require('./WhatsApp');
const { handleIncomingInstagramMessage } = require('./Instagram');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const path = require('path');

const publicPath = path.join(__dirname, 'public');
console.log('Serving static files from:', publicPath);
app.use(express.static(publicPath));

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(publicPath, 'privacy.html'));
});

app.get('/health', (req, res) => {
  res.send('Bot server is running ✅');
});

// Instagram Business Login redirect URL — placeholder for now.
// Only used when a business owner connects their own Instagram account
// via OAuth. Not required for basic message send/receive testing.
app.get('/auth/instagram/callback', (req, res) => {
  const code = req.query.code;
  console.log('Instagram OAuth callback received, code:', code);
  res.send('Instagram account connected. You can close this window.');
});

// Webhook verification — Meta calls this once when you save the webhook URL
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  console.log('Webhook verification failed');
  return res.sendStatus(403);
});

// Incoming messages — WhatsApp and Instagram both POST here
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('Incoming webhook payload:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
      await handleIncomingWhatsAppMessage(body);
    } else if (body.object === 'instagram') {
      await handleIncomingInstagramMessage(body);
    } else {
      console.log('Unknown webhook object type:', body.object);
    }
  } catch (err) {
    console.error('Error processing webhook:', err);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
