require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const { handleIncomingWhatsAppMessage } = require('./Whatsapp');
const { handleIncomingInstagramMessage } = require('./Instagram');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

app.get('/', (req, res) => {
  res.send('Bot server is running ✅');
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
