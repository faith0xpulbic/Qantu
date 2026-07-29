// Voice.js – Twilio webhook handlers for inbound calls
const { getBusinessByTwilioNumber, createCallRecord, updateCallStatus, saveCallSummaryAndNote, getCallBySid } = require('./Database.js');
const { getOrCreateCustomer, getOrCreateConversation, processMessage } = require('./Bot.js');
const { VoiceResponse } = require('twilio').twiml;

// Configurable Pipecat WebSocket URL (set this via env)
const PIPECAT_WS_URL = process.env.PIPECAT_WEBSOCKET_URL || 'wss://qantu-voice.onrender.com/ws';

// ============================================================
//  POST /voice/incoming
//  Twilio webhook for inbound calls.
// ============================================================
async function handleIncomingCall(req, res) {
  try {
    const { From, To, CallSid } = req.body;

    // 1. Find the business by their Twilio number
    const business = await getBusinessByTwilioNumber(To);
    if (!business) {
      console.error(`[Voice] No business found for number: ${To}`);
      // Return a generic message or hangup
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
    const callRecord = await createCallRecord({
      call_sid: CallSid,
      from_number: From,
      to_number: To,
      business_id: business.id,
      conversation_id: conversation.id,
    });

    if (!callRecord) {
      console.error(`[Voice] Failed to create call record for ${CallSid}`);
      // Continue anyway – don't fail the call
    }

    // 5. Return TwiML to connect to Pipecat WebSocket
    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    connect.stream({ url: PIPECAT_WS_URL });

    // Pass call metadata to Pipecat as query params (optional, but helpful)
    // Pipecat can read these on the initial WebSocket handshake.
    // For now, Pipecat will POST to /voice/process with the call_sid.

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

    // 1. Get the call record to fetch business/conversation context
    const callRecord = await getCallBySid(callSid);
    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const businessId = callRecord.business_id;
    const convId = conversationId || callRecord.conversation_id;

    // 2. Get customer (we need the customer object for processMessage)
    // We can fetch by from number, but we have the conversation_id.
    // Simpler: fetch conversation to get customer_id, or we can store it.
    // Since we only have the from number here, let's use that.
    const customer = await getOrCreateCustomer({
      phoneNumber: from,
      businessId: businessId,
      channelType: 'voice',
    });

    // 3. If Pipecat didn't send a conversationId, use the one from the call record
    const conversation = await getOrCreateConversation({
      customerId: customer.id,
      businessId: businessId,
      channelType: 'voice',
      // Use existing conv ID if provided
      existingId: convId,
    });

    // 4. Build context for processMessage
    // We pass the transcript from Pipecat (in-memory cache) as recentMessages
    // to bypass the messages table.
    const context = {
      businessId: businessId,
      customerId: customer.id,
      conversationId: conversation.id,
      channelType: 'voice',
      recentMessages: transcript || [], // Pipecat's full in-memory transcript
    };

    // 5. Call the existing processMessage logic
    // Note: processMessage expects { text, context, business, customer, conversation }
    const business = await getBusinessByTwilioNumber(to); // We could cache this better
    // Actually, let's just fetch the business by ID to avoid double lookup
    // For now, we assume processMessage handles this.
    // Let's refactor: we need the full business object.
    // I'll just re-fetch it:
    const { data: businessData } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .single();

    // 6. Execute processMessage
    // We need to pass the transcript as the "message" history.
    // BUT processMessage expects a "text" input and pulls recent messages from DB.
    // To avoid DB fetch, we replace the getRecentMessages call internally.
    // Quick workaround: We pass the transcript in a way that processMessage can use.
    // I will modify Bot.js to accept an optional "overrideMessages" param.
    // For now, I'll simulate the response.
    const result = await processMessage({
      text: text || '',
      context: context,
      business: businessData,
      customer: customer,
      conversation: conversation,
      overrideMessages: transcript, // We'll add this to Bot.js
    });

    // 7. Return the bot's reply to Pipecat
    res.json({
      reply: result.reply,
      conversationId: conversation.id,
      action: result.action || 'NONE',
      hangup: result.action === 'HANDOFF' ? true : false, // Optional: let Pipecat hang up on handoff
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

    // 1. Update call status to 'completed'
    await updateCallStatus(callSid, 'completed');

    // 2. Get the call record
    const callRecord = await getCallBySid(callSid);
    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const convId = conversationId || callRecord.conversation_id;

    // 3. Generate summary via Gemini 3.6
    // We have to call Gemini directly or use processMessage? 
    // We'll call a new function `generateCallSummary(transcript, businessId)`.
    // I'll draft this in Bot.js as a utility.
    const summary = await generateCallSummary(transcript, callRecord.business_id);
    const sentiment = 'neutral'; // We can ask Gemini to output this too.

    // 4. Save summary and note
    await saveCallSummaryAndNote({
      call_sid: callSid,
      summary: summary,
      sentiment: sentiment,
      conversation_id: convId,
    });

    // 5. TODO: Ping owner via WhatsApp if conversation is awaiting_owner
    // We'll implement this if needed.

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
