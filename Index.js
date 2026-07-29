require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const { handleIncomingWhatsAppMessage } = require('./WhatsApp');
const { handleIncomingInstagramMessage } = require('./Instagram');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Twilio sends form-encoded, not JSON

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const path = require('path');

const publicPath = path.join(__dirname, 'public');
console.log('Serving static files from:', publicPath);
app.use(express.static(publicPath));

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(publicPath, 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(publicPath, 'terms.html'));
});

app.get('/data-deletion', (req, res) => {
  res.sendFile(path.join(publicPath, 'data-deletion.html'));
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

// Twilio hits this once when a call comes in. It doesn't handle the
// conversation itself, it just tells Twilio where to stream the raw
// call audio, our Pipecat service, which does the actual STT/LLM/TTS loop.
app.post('/voice/incoming', (req, res) => {
  console.log('Incoming call from:', req.body.From);

  const pipecatUrl = process.env.PIPECAT_WEBSOCKET_URL;

  if (!pipecatUrl) {
    console.error('PIPECAT_WEBSOCKET_URL not set — cannot connect the call');
    res.type('text/xml');
    return res.send(`<Response><Say>Sorry, we are unable to take your call right now.</Say></Response>`);
  }

  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${pipecatUrl}" />
      </Connect>
    </Response>
  `);
});

app.post('/voice/process', async (req, res) => {
  try {
    await handleVoiceProcess(req, res);
  } catch (err) {
    console.error('Error in /voice/process:', err);
    res.json({ reply: "Sorry, we're having trouble right now." });
  }
});

app.post('/voice/end', async (req, res) => {
  try {
    await handleVoiceEnd(req, res);
  } catch (err) {
    console.error('Error in /voice/end:', err);
    res.json({ ok: false });
  }
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
