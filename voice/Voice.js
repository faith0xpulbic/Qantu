const {
  getBusinessByTwilioNumber,
  findOrCreateCustomer,
  getOrCreateActiveConversation,
  updateConversationStatus,
  createCall,
  getCallBySid,
  completeCall,
  saveNote,
  getNotes,
  getBusinessSettings,
  getBusinessKnowledge,
  getTag,
  setTag,
  updateCustomerName,
} = require('../Database');
const { processMessage } = require('../Bot');
const { pingOwner } = require('../WhatsApp');

// ============================================
// /voice/incoming
// Twilio hits this the moment a call connects. We don't create the
// customer/conversation/call records here, app.py's bridge only has
// call_sid/from/to at connect time, so resolution happens lazily on the
// FIRST /voice/process call instead. This endpoint's only job is telling
// Twilio where to stream the audio.
// ============================================

async function handleIncomingCall(req, res) {
  const fromNumber = req.body.From;
  const toNumber = req.body.To;
  const callSid = req.body.CallSid;

  console.log(`Incoming call — from: ${fromNumber}, to: ${toNumber}, sid: ${callSid}`);

  const pipecatUrl = process.env.PIPECAT_WEBSOCKET_URL;

  if (!pipecatUrl) {
    console.error('PIPECAT_WEBSOCKET_URL not set — cannot connect the call');
    res.type('text/xml');
    return res.send('<Response><Say>Sorry, we are unable to take your call right now.</Say></Response>');
  }

  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${pipecatUrl}" />
      </Connect>
    </Response>
  `);
}

// Resolves business/customer/conversation/call the first time this call_sid
// is seen, and creates the call record. Later turns pass the cached IDs
// straight through instead of hitting the database again for lookup.
async function resolveCallContext({ callSid, fromNumber, toNumber, conversationId, businessId, customerId }) {
  if (conversationId && businessId && customerId) {
    return { conversationId, businessId, customerId };
  }

  const business = await getBusinessByTwilioNumber(toNumber);
  if (!business) {
    console.error('No business found for Twilio number:', toNumber);
    return null;
  }

  const customer = await findOrCreateCustomer(business.id, 'call', fromNumber);
  const conversation = await getOrCreateActiveConversation(business.id, customer.id, 'call');

  const existingCall = await getCallBySid(callSid);
  if (!existingCall) {
    await createCall({
      businessId: business.id,
      conversationId: conversation.id,
      callSid,
      fromNumber,
      toNumber,
    });
  }

  return {
    conversationId: conversation.id,
    businessId: business.id,
    customerId: customer.id,
  };
}

// ============================================
// /voice/process
// Pipecat's bridge POSTs here on every caller turn (camelCase keys,
// matching app.py exactly), with the FULL transcript held in ITS OWN
// memory, not our database, per the locked plan, voice turns never touch
// the messages table. We rebuild context the same way WhatsApp.js/
// Instagram.js do, but pass Pipecat's transcript directly as
// recentMessages instead of calling getRecentMessages.
// ============================================

async function handleVoiceProcess(req, res) {
  const {
    callSid,
    from: fromNumber,
    to: toNumber,
    text,
    transcript,
    conversationId: cachedConversationId,
    businessId: cachedBusinessId,
    customerId: cachedCustomerId,
  } = req.body;

  if (!callSid) {
    return res.status(400).json({ error: 'Missing callSid' });
  }

  const resolved = await resolveCallContext({
    callSid,
    fromNumber,
    toNumber,
    conversationId: cachedConversationId,
    businessId: cachedBusinessId,
    customerId: cachedCustomerId,
  });

  if (!resolved) {
    return res.json({ reply: "Sorry, this number isn't set up yet." });
  }

  const { conversationId, businessId, customerId } = resolved;

  const businessSettings = await getBusinessSettings(businessId);
  const businessKnowledge = await getBusinessKnowledge(businessId);
  const notes = await getNotes(conversationId);
  const currentTag = await getTag(conversationId);

  const recentMessages = (transcript || []).map(t => ({
    role: t.role === 'customer' ? 'customer' : 'assistant',
    content: t.content,
  }));

  const context = {
    businessSettings,
    businessKnowledge,
    notes,
    recentMessages,
    currentTag,
    channelType: 'call',
  };

  const result = await processMessage(context, text || '');

  if (result.save_note) {
    await saveNote(conversationId, result.save_note);
  }

  if (result.tag) {
    await setTag(conversationId, result.tag);
  }

  if (result.customer_name && customerId) {
    await updateCustomerName(customerId, result.customer_name);
  }

  if (result.action === 'PING_OWNER' || result.action === 'HANDOFF') {
    const business = await getBusinessByTwilioNumber(toNumber);
    if (business && result.owner_summary) {
      const label = result.action === 'HANDOFF' ? '⚠️ *Call Handoff*' : '📞 *Call Update*';
      await pingOwner(business, `${label}\n\n${result.owner_summary}`, conversationId, customerId);
    }
    await updateConversationStatus(conversationId, result.action === 'HANDOFF' ? 'handed_off' : 'awaiting_owner');
  }

  res.json({
    reply: result.reply,
    conversationId,
    businessId,
    customerId,
    action: result.action,
  });
}

// ============================================
// /voice/end
// app.py's bridge POSTs the full transcript here once the call
// disconnects. This is the ONLY point voice content gets permanently
// written, one summary, saved in two places: calls.summary and
// conversation_notes.
// ============================================

async function handleVoiceEnd(req, res) {
  const { callSid, conversationId, transcript } = req.body;

  if (!callSid) {
    return res.status(400).json({ error: 'Missing callSid' });
  }

  const call = await getCallBySid(callSid);
  if (!call) {
    console.error('No call record found for sid:', callSid);
    return res.status(404).json({ error: 'Call not found' });
  }

  const summary = await summarizeCall(transcript || []);

  await completeCall(callSid, { summary });

  const targetConversationId = conversationId || call.conversation_id;
  if (targetConversationId) {
    await saveNote(targetConversationId, summary);
  }

  if (call.business_id) {
    const business = await getBusinessByTwilioNumber(call.to_number);
    if (business && targetConversationId) {
      const currentTag = await getTag(targetConversationId);
      if (currentTag === 'needs_followup') {
        await pingOwner(business, `📞 *Call Ended*\n\n${summary}`, targetConversationId, null);
      }
    }
  }

  console.log(`Call ${callSid} completed, summary saved: ${summary}`);
  res.json({ status: 'ok', summary });
}

async function summarizeCall(transcript) {
  const axios = require('axios');

  if (!transcript || transcript.length === 0) {
    return 'Call connected but no conversation took place.';
  }

  const transcriptText = transcript.map(t => `${t.role}: ${t.content}`).join('\n');

  const prompt = `Summarize this phone call for the business owner in 2-3 short sentences. Lead with what the caller wanted and what was resolved or left open. Write it the way you'd text a quick update to someone, not a formal report.\n\n${transcriptText}`;

  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' } }
    );
    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Call completed, summary unavailable.';
  } catch (err) {
    console.error('Error summarizing call:', err.response?.data || err.message);
    return 'Call completed, summary unavailable.';
  }
}

module.exports = { handleIncomingCall, handleVoiceProcess, handleVoiceEnd };
