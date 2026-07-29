// Qantu - Voice Webhook Handlers (Node.js)
const { supabase } = require('../SupabaseClient.js');
const { VoiceResponse } = require('twilio').twiml;
const {
  getBusinessByTwilioNumber,
  createCallRecord,
  updateCallStatus,
  saveCallSummaryAndNote,
  getCallBySid,
} = require('../Database.js');
const {
  getOrCreateCustomer,
  getOrCreateConversation,
  processMessage,
  generateCallSummary,
} = require('../Bot.js');

// Pipecat WebSocket URL (from env)
const PIPECAT_WS_URL = process.env.PIPECAT_WEBSOCKET_URL || 'wss://qantu-voice.onrender.com/ws';

// ============================================================
//  POST /voice/incoming
//  Twilio webhook for inbound calls.
// ============================================================
async function handleIncomingCall(req, res) {
  try {
    const { From, To, CallSid } = req.body;

    // 1. Find business by their Twilio number
    const business = await getBusinessByTwilioNumber(To);
    if (!business) {
      console.error(`[Voice] No business found for number: ${To}`);
      const twiml = new VoiceResponse();
      twiml.say('Sorry, this number is not registered.');
      return res.type('text/xml').send(twiml.toString());
    }

    // 2. Get or create customer (channel = 'voice')
    const customer = await getOrCreateCustomer({
      phoneNumber: From,
      businessId: business.id,
      channelType: 'voice',
    });

    // 3. Get or create conversation
    const conversation = await getOrCreateConversation({
      customerId: customer.id,
      businessId: business.id,
      channelType: 'voice',
      status: 'active',
    });

    // 4. Create the call record
    await createCallRecord({
      call_sid: CallSid,
      from_number: From,
      to_number: To,
      business_id: business.id,
      conversation_id: conversation.id,
    });

    // 5. Return TwiML to connect to Pipecat WebSocket
    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    connect.stream({ url: PIPECAT_WS_URL });

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[Voice] /incoming error:', err);
    const twiml = new VoiceResponse();
    twiml.say('An error occurred. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
}

// ============================================================
//  POST /voice/process
//  Called by Pipecat with each user utterance + transcript.
// ============================================================
async function handleProcessTurn(req, res) {
  try {
    const { callSid, from, to, text, transcript, conversationId } = req.body;

    if (!callSid) {
      return res.status(400).json({ error: 'callSid required' });
    }

    // 1. Get the call record
    const callRecord = await getCallBySid(callSid);
    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // 2. Fetch business, customer, conversation
    const business = await getBusinessByTwilioNumber(to);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const customer = await getOrCreateCustomer({
      phoneNumber: from,
      businessId: business.id,
      channelType: 'voice',
    });

    const convId = conversationId || callRecord.conversation_id;
    const conversation = await getOrCreateConversation({
      customerId: customer.id,
      businessId: business.id,
      channelType: 'voice',
      existingId: convId,
    });

    // 3. Call processMessage with overrideMessages = Pipecat's transcript
    const result = await processMessage({
      text: text || '', // empty text triggers greeting (silence timer)
      context: { channelType: 'voice' },
      business,
      customer,
      conversation,
      overrideMessages: transcript || [], // ← Pipecat's in-memory transcript
    });

    // 4. Return reply to Pipecat
    res.json({
      reply: result.reply,
      conversationId: conversation.id,
      action: result.action || 'NONE',
      hangup: result.action === 'HANDOFF' ? true : false,
    });
  } catch (err) {
    console.error('[Voice] /process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
//  POST /voice/end
//  Called by Pipecat when the call ends (with full transcript).
// ============================================================
async function handleEndCall(req, res) {
  try {
    const { callSid, transcript, conversationId } = req.body;

    if (!callSid) {
      return res.status(400).json({ error: 'callSid required' });
    }

    // 1. Update call status
    await updateCallStatus(callSid, 'completed');

    // 2. Get the call record
    const callRecord = await getCallBySid(callSid);
    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const convId = conversationId || callRecord.conversation_id;

    // 3. Generate summary via Gemini 3.6
    const { summary, sentiment } = await generateCallSummary(
      transcript || [],
      callRecord.business_id
    );

    // 4. Save summary to calls + conversation_notes
    await saveCallSummaryAndNote({
      call_sid: callSid,
      summary: summary || 'No summary available.',
      sentiment: sentiment || 'neutral',
      conversation_id: convId,
    });

    // 5. (Optional) Ping owner if conversation is awaiting_owner
    // You can check conversation status and send WhatsApp here

    res.json({ success: true });
  } catch (err) {
    console.error('[Voice] /end error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  handleIncomingCall,
  handleProcessTurn,
  handleEndCall,
};
