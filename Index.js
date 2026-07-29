// Qantu - Main Express Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { VoiceResponse } = require('twilio').twiml;

// Import all handlers
const { handleWhatsAppIncoming, handleWhatsAppStatus } = require('./WhatsApp.js');
const { handleInstagramIncoming } = require('./Instagram.js');
const { handleIncomingCall, handleProcessTurn, handleEndCall } = require('./voice/Voice.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio sends form-urlencoded

// Health check
app.get('/', (req, res) => {
  res.send('Qantu API is running 🚀');
});

// ============================================================
//  WEBHOOKS
// ============================================================

// WhatsApp
app.post('/whatsapp/incoming', handleWhatsAppIncoming);
app.post('/whatsapp/status', handleWhatsAppStatus);

// Instagram (placeholder / future)
app.post('/instagram/incoming', handleInstagramIncoming);

// ============================================================
//  VOICE (Twilio Phone Calls)
// ============================================================
app.post('/voice/incoming', handleIncomingCall);
app.post('/voice/process', handleProcessTurn);
app.post('/voice/end', handleEndCall);

// ============================================================
//  START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Qantu server running on port ${PORT}`);
});
