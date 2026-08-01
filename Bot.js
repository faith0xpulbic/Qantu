
const axios = require('axios');
const { SYSTEM_PROMPT, VOICE_CALL_ADDENDUM } = require('./prompts');

// Guaranteed cleanup, independent of whether the model follows the prompt
// instruction. Strips dashes and brackets/parentheses since these read as
// obviously AI-written and models don't always avoid them reliably.
function cleanReply(text) {
  if (!text) return text;
  return text
    .replace(/[-–—]/g, ',')        // replace dashes with a comma so sentences still read naturally
    .replace(/[()[\]{}]/g, '')     // strip all bracket types entirely
    .replace(/,\s*,/g, ',')        // clean up any accidental double commas from the dash replacement
    .replace(/\s{2,}/g, ' ')       // collapse extra spaces left behind
    .trim();
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-3.6-flash';

// Exact schema Gemini is constrained to follow — this is stronger than
// Groq's json_object mode since Gemini enforces field types and required
// fields at the decoding level, not just "valid JSON somehow".
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['NONE', 'PING_OWNER', 'HANDOFF'] },
    action_reason: { type: 'string', nullable: true },
    owner_summary: { type: 'string', nullable: true },
    save_note: { type: 'string', nullable: true },
    tag: { type: 'string', enum: ['needs_followup', 'none'], nullable: true },
    customer_name: { type: 'string', nullable: true },
  },
  required: ['reply', 'action'],
};

// Builds the final system prompt by injecting this business's settings,
// its factual knowledge, the bot's own notes, and the conversation's
// current tag, so it can decide whether to keep, clear, or change it
// with actual context, rather than blindly overwriting each turn.
// channelType switches in the voice-specific addendum when this is a call,
// left out entirely for WhatsApp/Instagram so the text-channel prompt
// stays exactly as it was.
function buildSystemPrompt(businessSettings, businessKnowledge, notes, currentTag, channelType) {
  let prompt = SYSTEM_PROMPT;

  if (channelType === 'call') {
    prompt += VOICE_CALL_ADDENDUM;
  }

  const settingsEntries = Object.entries(businessSettings || {});
  if (settingsEntries.length > 0) {
    const settingsText = settingsEntries
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
    prompt += `\n\nBUSINESS SETTINGS (follow these rules for this business):\n${settingsText}`;
  }

  if (businessKnowledge && businessKnowledge.length > 0) {
    const knowledgeText = businessKnowledge
      .map(k => `[${k.category}]\n${k.content}`)
      .join('\n\n');
    prompt += `\n\nBUSINESS INFORMATION (use this to answer customer questions accurately):\n${knowledgeText}`;
  }

  if (notes && notes.length > 0) {
    const notesText = notes.map(n => `- ${n.note}`).join('\n');
    prompt += `\n\nYOUR OWN NOTES ABOUT THIS CONVERSATION SO FAR:\n${notesText}`;
  }

  prompt += `\n\nCURRENT TAG ON THIS CONVERSATION: ${currentTag || 'none'}. If it's already "needs_followup" and this message resolves what you were waiting on (e.g. they paid, they answered, they came back), clear it by returning "none". If nothing has changed, keep returning the same tag. Only set "needs_followup" fresh if something new is now unresolved.`;

  return prompt;
}

// Formats a time gap between two messages into a short, natural marker.
// Only returned for gaps large enough to matter.
function formatGap(previousTimestamp, currentTimestamp) {
  if (!previousTimestamp) return null;

  const diffMs = new Date(currentTimestamp) - new Date(previousTimestamp);
  const diffMinutes = diffMs / (1000 * 60);
  const diffHours = diffMinutes / 60;
  const diffDays = diffHours / 24;

  if (diffMinutes < 30) return null;
  if (diffHours < 24) return `[${Math.round(diffHours)} hour(s) later]`;
  if (diffDays < 7) return `[${Math.round(diffDays)} day(s) later]`;
  return `[over a week later]`;
}

// context = { businessSettings, businessKnowledge, notes, recentMessages, currentTag, channelType }
async function processMessage(context, text, mediaUrl = null) {
  const { businessSettings, businessKnowledge, notes, recentMessages, currentTag, channelType } = context;

  const systemPrompt = buildSystemPrompt(businessSettings, businessKnowledge, notes, currentTag, channelType);

  // Gemini's format: each turn is a 'content' object with role 'user' or
  // 'model' (not 'assistant'), and text lives inside a 'parts' array.
  const history = [];
  let previousTimestamp = null;

  for (const m of (recentMessages || [])) {
    const gapMarker = formatGap(previousTimestamp, m.created_at);

    let role, content;
    if (m.role === 'customer') {
      role = 'user';
      content = m.content;
    } else if (m.role === 'owner') {
      role = 'user';
      content = `[This was the business owner speaking to you privately, not the customer]: ${m.content}`;
    } else if (m.role === 'owner_ping') {
      // This is the bot's own prior message to the owner, so it's a
      // model-role turn, just clearly labeled as owner-directed rather
      // than customer-directed.
      role = 'model';
      content = `[You said this to the business owner privately]: ${m.content}`;
    } else {
      role = 'model';
      content = m.content;
    }

    if (gapMarker) {
      history.push({ role, parts: [{ text: `${gapMarker} ${content}` }] });
    } else {
      history.push({ role, parts: [{ text: content }] });
    }
    previousTimestamp = m.created_at;
  }

  const userContent = mediaUrl
    ? (text ? `[Customer sent an image with caption: "${text}"]` : `[Customer sent an image — no caption]`)
    : text;

  const requestPayload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      ...history,
      { role: 'user', parts: [{ text: userContent }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
    },
  };

  // Rough payload size in characters — correlate with slow turns to see if
  // it's growing history/knowledge, not just raw Gemini processing time.
  const payloadSize = JSON.stringify(requestPayload).length;

  try {
    const geminiStart = Date.now();
    console.log(`[gemini] Sending request — model=${MODEL}, historyTurns=${history.length}, payloadChars=${payloadSize}`);

    const response = await axios.post(
      `${GEMINI_URL}/${MODEL}:generateContent`,
      requestPayload,
      {
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const geminiMs = Date.now() - geminiStart;
    console.log(`[gemini] Response received — ${geminiMs}ms, model=${MODEL}, historyTurns=${history.length}, payloadChars=${payloadSize}`);

    const rawText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    try {
      const parsed = JSON.parse(rawText);

      return {
        reply: cleanReply(parsed.reply) || "Thanks for your message, let me get back to you shortly.",
        action: parsed.action || 'NONE',
        action_reason: parsed.action_reason || null,
        owner_summary: parsed.owner_summary || null,
        save_note: parsed.save_note || null,
        tag: parsed.tag && parsed.tag !== 'none' ? parsed.tag : null,
        customer_name: parsed.customer_name || null,
      };
    } catch (parseErr) {
      console.error('Failed to parse Gemini response as JSON:', rawText);
      return {
        reply: cleanReply(rawText) || "Thanks for your message, let me get back to you shortly.",
        action: 'NONE',
        action_reason: null,
        owner_summary: null,
        save_note: null,
        tag: null,
        customer_name: null,
      };
    }
  } catch (err) {
    console.error('Error calling Gemini:', err.response?.data || err.message);
    return {
      reply: "Sorry, I'm having trouble responding right now, someone will follow up shortly.",
      action: 'NONE',
      action_reason: null,
      owner_summary: null,
      save_note: null,
    };
  }
}

module.exports = { processMessage, processOwnerMessage };

// ============================================
// OWNER-FACING PATH WITH TOOL CALLING
// Separate from processMessage because Gemini's structured responseSchema
// mode and function-calling (tools) mode aren't reliably combined in one
// call. This path lets the model request data before answering, per
// Gemini's documented multi-turn function calling pattern: the model can
// return a function call instead of a final answer, we execute it, then
// send the full history plus the result back in a new request.
// ============================================

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'get_conversation_history',
        description: 'Full message history, notes, and tags for one specific conversation. The conversation_id must be one of the IDs provided to you in the RECENT CONVERSATIONS list, never guess or construct an ID from anything the owner types, phone numbers, usernames, or other identifiers the owner mentions are NOT conversation IDs.',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string', description: 'The ID of the conversation to look up' },
          },
          required: ['conversation_id'],
        },
      },
      {
        name: 'get_recent_customer_statuses',
        description: 'A lightweight list of recent conversations for this business, showing only channel, status, tags, and notes, no message content. Use this for questions about activity or status across multiple customers, like who is waiting, who has gone quiet, or what needs follow up.',
        parameters: {
          type: 'object',
          properties: {
            hours_back: { type: 'number', description: 'How many hours back to look, defaults to 48 if not specified' },
          },
        },
      },
      {
        name: 'send_message_to_customer',
        description: 'Sends a message to a specific customer on their conversation. Use this when the owner has given you information or an instruction meant to be relayed to a customer, like bank details, a price, or an answer to their question. Write the message the way you would naturally say it to that customer, not the owner\'s raw words.',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string', description: 'The ID of the conversation to send the message to' },
            message: { type: 'string', description: 'The message to send, written naturally for the customer' },
          },
          required: ['conversation_id', 'message'],
        },
      },
    ],
  },
];

// Executes a tool the model requested, using the actual database functions.
// Injected as arguments since Bot.js shouldn't import Database.js directly,
// keeping the database layer decoupled from the AI layer.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strips the invisible reference marker some stored messages carry
// (embedded by WhatsApp.js/Instagram.js when pinging the owner) before
// showing message content back to the model as readable text.
function stripRefMarker(text) {
  if (!text) return text;
  return text.replace(/\n?<!--ref:[^>]+-->/, '').trim();
}

async function executeTool(name, args, dbFunctions) {
  if (name === 'get_conversation_history') {
    if (!UUID_PATTERN.test(args.conversation_id || '')) {
      return { error: 'That is not a valid conversation_id, only use IDs from the RECENT CONVERSATIONS list provided to you, not phone numbers or usernames.' };
    }
    const context = await dbFunctions.getConversationFullContext(args.conversation_id);
    if (context && context.messages) {
      context.messages = context.messages.map(m => ({ ...m, content: stripRefMarker(m.content) }));
    }
    return context;
  }
  if (name === 'get_recent_customer_statuses') {
    return await dbFunctions.getRecentCustomerStatuses(dbFunctions.businessId, args.hours_back || 48);
  }
  if (name === 'send_message_to_customer') {
    if (!UUID_PATTERN.test(args.conversation_id || '')) {
      return { error: 'That is not a valid conversation_id, only use IDs from the RECENT CONVERSATIONS list provided to you, not phone numbers or usernames.' };
    }
    const sent = await dbFunctions.sendToCustomer(args.conversation_id, args.message);
    return { sent, conversation_id: args.conversation_id };
  }
  return { error: `Unknown tool: ${name}` };
}

// ownerContext = { businessSettings, businessKnowledge, recentOwnerContext }
// dbFunctions = { getConversationFullContext, getRecentCustomerStatuses, businessId }
async function processOwnerMessage(ownerContext, ownerText, dbFunctions) {
  const { businessSettings, businessKnowledge, recentOwnerContext } = ownerContext;

  let systemPrompt = buildSystemPrompt(businessSettings, businessKnowledge, null);
  systemPrompt += `\n\nYou are currently talking to the business owner, not a customer. Answer their question directly and conversationally, don't use the reply/action JSON format for this, just respond naturally. Use the tools available if you need to look something up before answering.`;

  if (recentOwnerContext && recentOwnerContext.length > 0) {
    const contextText = recentOwnerContext
      .map(c => `conversation_id: ${c.conversation_id}, channel: ${c.channel}, status: ${c.status}, tag: ${c.tag || 'none'}, last ping: "${c.lastPing}"`)
      .join('\n');
    systemPrompt += `\n\nRECENT CONVERSATIONS YOU'VE BROUGHT TO THE OWNER'S ATTENTION (most recent first):\n${contextText}`;
  }

  let contents = [{ role: 'user', parts: [{ text: ownerText }] }];

  // Allow a few rounds of tool calls before giving up, in case the model
  // needs to look up more than one thing before it can answer.
  for (let round = 0; round < 4; round++) {
    try {
      const response = await axios.post(
        `${GEMINI_URL}/${MODEL}:generateContent`,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: TOOLS,
          generationConfig: { temperature: 0.5 },
        },
        {
          headers: {
            'x-goog-api-key': process.env.GEMINI_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const candidate = response.data.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCallPart = parts.find(p => p.functionCall);

      if (functionCallPart) {
        const { name, args } = functionCallPart.functionCall;
        console.log(`Owner-facing bot calling tool: ${name}`, args);

        const result = await executeTool(name, args || {}, dbFunctions);

        // Gemini requires the thoughtSignature to be preserved exactly as
        // received when echoing the function call back. Without it, the
        // API rejects the next request outright. Fall back to the
        // documented dummy signature if none was returned, since some
        // responses may omit it depending on thinking configuration.
        const modelPart = { functionCall: functionCallPart.functionCall };
        if (functionCallPart.thoughtSignature) {
          modelPart.thoughtSignature = functionCallPart.thoughtSignature;
        } else {
          modelPart.thoughtSignature = 'skip_thought_signature_validator';
        }

        contents.push({ role: 'model', parts: [modelPart] });
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: { result } } }],
        });
        continue; // loop again, sending the tool result back
      }

      const textPart = parts.find(p => p.text);
      const finalText = cleanReply(textPart?.text?.trim()) || "Let me check on that and get back to you.";
      return { reply: finalText };
    } catch (err) {
      console.error('Error calling Gemini for owner message:', err.response?.data || err.message);
      return { reply: "Sorry, having trouble processing that right now, try again in a moment." };
    }
  }

  return { reply: "I looked into a few things but couldn't quite pin it down, can you give me a bit more to go on?" };
}
