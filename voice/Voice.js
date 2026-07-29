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

const PIPECAT_WS_URL = process.env.PIPECAT_WEBSOCKET_URL || 'wss://qantu-voice.onrender.com/ws';

// ============================================================
//  POST /voice/incoming
// ============================================================
async function handleIncomingCall(req, res) {
  try {
    const { From, To, CallSid } = req.body;

    const business = await getBusinessByTwilioNumber(To);
    if (!business) {
      const twiml = new VoiceResponse();
      twiml.say('Sorry, this number is not registered.');
      return res.type('text/xml').send(twiml.toString());
    }

    const customer = await getOrCreateCustomer({
      phoneNumber: From,
      businessId: business.id,
      channelType: 'voice',
    });

    const conversation = await getOrCreateConversation({
      customerId: customer.id,
      businessId: business.id,
      channelType: 'voice',
    });

    await createCallRecord({
      call_sid: CallSid,
      from_number: From,
      to_number: To,
      business_id: business.id,
      conversation_id: conversation.id,
    });

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
// ============================================================
async function handleProcessTurn(req, res) {
  try {
    const { callSid, from, to, text, transcript, conversationId } = req.body;

    if (!callSid) return res.status(400).json({ error: 'callSid required' });

    const callRecord = await getCallBySid(callSid);
    if (!callRecord) return res.status(404).json({ error: 'Call not found' });

    const business = await getBusinessByTwilioNumber(to);
    if (!business) return res.status(404).json({ error: 'Business not found' });

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

    // --- THE IMPORTANT PART ---
    // Your existing processMessage signature: (context, text, mediaUrl)
    // We pass Pipecat's transcript as `recentMessages` inside context.
    const context = {
      businessSettings: business.business_settings || {},
      businessKnowledge: business.business_knowledge || [],
      notes: [], // We don't need to fetch notes here; your function handles this via the prompt builder's `notes` param if needed.
      recentMessages: transcript || [], // ← Pipecat's in-memory transcript bypasses the messages table.
      currentTag: conversation.tag || 'none',
      channelType: 'call', // ← triggers your VOICE_CALL_ADDENDUM
    };

    const result = await processMessage(context, text || ''); // empty text triggers greeting

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
// ============================================================
async function handleEndCall(req, res) {
  try {
    const { callSid, transcript, conversationId } = req.body;

    if (!callSid) return res.status(400).json({ error: 'callSid required' });

    await updateCallStatus(callSid, 'completed');

    const callRecord = await getCallBySid(callSid);
    if (!callRecord) return res.status(404).json({ error: 'Call not found' });

    const convId = conversationId || callRecord.conversation_id;

    // Fetch business settings for the summary context
    const { data: business } = await supabase
      .from('businesses')
      .select('business_settings, business_knowledge')
      .eq('id', callRecord.business_id)
      .single();

    const { summary, sentiment } = await generateCallSummary(
      transcript || [],
      business?.business_settings || {},
      business?.business_knowledge || []
    );

    await saveCallSummaryAndNote({
      call_sid: callSid,
      summary: summary || 'No summary available.',
      sentiment: sentiment || 'neutral',
      conversation_id: convId,
    });

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
