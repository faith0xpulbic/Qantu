const { supabase } = require('./SupabaseClient');

// ============================================
// BUSINESS LOOKUP
// Every incoming message needs to resolve to a business first —
// everything else is scoped underneath that business_id.
// ============================================

async function getBusinessByWhatsAppPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('whatsapp_phone_number_id', phoneNumberId)
    .single();

  if (error) {
    console.error('Error looking up business by WhatsApp phone_number_id:', error.message);
    return null;
  }
  return data;
}

async function getBusinessByInstagramAccountId(instagramAccountId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('instagram_account_id', instagramAccountId)
    .single();

  if (error) {
    console.error('Error looking up business by Instagram account_id:', error.message);
    return null;
  }
  return data;
}

async function updateCustomerName(customerId, name) {
  const { error } = await supabase
    .from('customers')
    .update({ name })
    .eq('id', customerId);

  if (error) {
    console.error('Error updating customer name:', error.message);
  }
}

// ============================================
// CUSTOMER + CHANNEL LOOKUP
// Given a business and a channel identifier (phone number or IG user ID),
// find the existing customer or create a new one.
// ============================================

async function findOrCreateCustomer(businessId, channelType, channelIdentifier) {
  // First, check if this exact channel is already linked to a customer
  const { data: existingChannel, error: channelError } = await supabase
    .from('customer_channels')
    .select('customer_id')
    .eq('business_id', businessId)
    .eq('channel_type', channelType)
    .eq('channel_identifier', channelIdentifier)
    .maybeSingle();

  if (channelError) {
    console.error('Error looking up customer_channels:', channelError.message);
  }

  if (existingChannel) {
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', existingChannel.customer_id)
      .single();

    if (customerError) {
      console.error('Error fetching existing customer:', customerError.message);
      return null;
    }
    return customer;
  }

  // No existing channel found — create a brand new customer + channel link
  const { data: newCustomer, error: newCustomerError } = await supabase
    .from('customers')
    .insert({
      business_id: businessId,
      primary_phone: channelType === 'whatsapp' ? channelIdentifier : null,
    })
    .select()
    .single();

  if (newCustomerError) {
    console.error('Error creating new customer:', newCustomerError.message);
    return null;
  }

  const { error: newChannelError } = await supabase
    .from('customer_channels')
    .insert({
      customer_id: newCustomer.id,
      business_id: businessId,
      channel_type: channelType,
      channel_identifier: channelIdentifier,
      confirmed: true, // the channel they messaged FROM is trivially confirmed —
                        // cross-channel linking (e.g. call number = WhatsApp number)
                        // is a separate, explicit confirmation step, added later
    });

  if (newChannelError) {
    console.error('Error creating customer_channel:', newChannelError.message);
  }

  return newCustomer;
}

// ============================================
// CONVERSATIONS
// One active conversation per customer per channel at a time.
// ============================================

async function getOrCreateActiveConversation(businessId, customerId, channelType) {
  const { data: existing, error: existingError } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .eq('channel_type', channelType)
    .neq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    console.error('Error looking up active conversation:', existingError.message);
  }

  if (existing) return existing;

  const { data: newConversation, error: newError } = await supabase
    .from('conversations')
    .insert({ business_id: businessId, customer_id: customerId, channel_type: channelType })
    .select()
    .single();

  if (newError) {
    console.error('Error creating conversation:', newError.message);
    return null;
  }
  return newConversation;
}

async function updateConversationStatus(conversationId, status) {
  const { error } = await supabase
    .from('conversations')
    .update({ status })
    .eq('id', conversationId);

  if (error) {
    console.error('Error updating conversation status:', error.message);
  }
}

// Finds conversations currently waiting on the owner for this business —
// used when the owner replies, to figure out which conversation(s) their
// reply might apply to.
async function getAwaitingOwnerConversations(businessId) {
  const { data: conversations, error } = await supabase
    .from('conversations')
    .select('*, customers(*)')
    .eq('business_id', businessId)
    .eq('status', 'awaiting_owner')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching awaiting_owner conversations:', error.message);
    return [];
  }

  // customer_channels isn't directly linked to conversations in the schema,
  // both are children of customers, so we fetch each conversation's
  // channels in a separate step rather than a single nested join.
  for (const conv of conversations) {
    const { data: channels, error: channelError } = await supabase
      .from('customer_channels')
      .select('channel_type, channel_identifier')
      .eq('customer_id', conv.customer_id);

    if (channelError) {
      console.error('Error fetching channels for conversation:', channelError.message);
      conv.customer_channels = [];
    } else {
      conv.customer_channels = channels;
    }
  }

  return conversations;
}

// Fetches one conversation by ID with its customer_channels populated,
// used by the send_message_to_customer tool to know where to actually
// deliver a message once the AI has decided which conversation to use.
async function getConversationById(conversationId) {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('*, customers(*)')
    .eq('id', conversationId)
    .single();

  if (error || !conversation) {
    console.error('Error fetching conversation by id:', error?.message);
    return null;
  }

  const { data: channels } = await supabase
    .from('customer_channels')
    .select('channel_type, channel_identifier')
    .eq('customer_id', conversation.customer_id);

  conversation.customer_channels = channels || [];
  return conversation;
}

// Finds whichever conversation this business most recently pinged the
// owner about, regardless of current status. Used as a fallback when
// nothing is actively awaiting_owner, but the owner is still following
// up on something after the fact (e.g. "have you sent it" after the
// conversation already moved back to active).
async function getMostRecentlyPingedConversation(businessId) {
  const { data: lastPing, error } = await supabase
    .from('messages')
    .select('conversation_id, created_at, conversations!inner(business_id)')
    .eq('role', 'owner_ping')
    .eq('conversations.business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !lastPing) {
    if (error) console.error('Error fetching most recently pinged conversation:', error.message);
    return null;
  }

  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('*, customers(*)')
    .eq('id', lastPing.conversation_id)
    .single();

  if (convError || !conversation) {
    console.error('Error fetching conversation for most recent ping:', convError?.message);
    return null;
  }

  const { data: channels } = await supabase
    .from('customer_channels')
    .select('channel_type, channel_identifier')
    .eq('customer_id', conversation.customer_id);

  conversation.customer_channels = channels || [];
  return conversation;
}

// ============================================
// MESSAGES
// Every message is saved automatically — no AI judgment needed here.
// ============================================

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });

  if (error) {
    console.error('Error saving message:', error.message);
  }
}

async function getRecentMessages(conversationId, limit = 15) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching recent messages:', error.message);
    return [];
  }
  // reverse so it reads oldest → newest, matching conversation order
  return data.reverse();
}

// ============================================
// CONVERSATION NOTES
// The bot's own private working memory — written only when it decides
// something is worth remembering, read back on every reply.
// ============================================

async function saveNote(conversationId, note) {
  const { error } = await supabase
    .from('conversation_notes')
    .insert({ conversation_id: conversationId, note });

  if (error) {
    console.error('Error saving conversation note:', error.message);
  }
}

async function getNotes(conversationId) {
  const { data, error } = await supabase
    .from('conversation_notes')
    .select('note, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching conversation notes:', error.message);
    return [];
  }
  return data;
}

// ============================================
// CONVERSATION TAG
// A single, simple status flag on the conversation itself, one at a time:
// 'needs_followup' (customer went quiet or asked something unresolved),
// or null (nothing notable). Kept as a plain column rather than a
// separate table since only one meaningful value is ever needed at once.
// ============================================

async function setTag(conversationId, tag) {
  const { error } = await supabase
    .from('conversations')
    .update({ tag })
    .eq('id', conversationId);

  if (error) {
    console.error('Error setting tag:', error.message);
  }
}

async function getTag(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('tag')
    .eq('id', conversationId)
    .single();

  if (error) {
    console.error('Error fetching tag:', error.message);
    return null;
  }
  return data?.tag || null;
}

// ============================================
// OWNER TOOL-CALLING SUPPORT
// Backing functions for the two tools the AI can call when answering
// an owner's message: one for full detail on a single conversation,
// one for a lightweight status sweep across many.
// ============================================

// Tool: get_conversation_history
// Full message history, notes, and tag for one specific conversation.
async function getConversationFullContext(conversationId) {
  const messages = await getRecentMessages(conversationId, 30);
  const notes = await getNotes(conversationId);

  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('*, customers(*)')
    .eq('id', conversationId)
    .single();

  if (error) {
    console.error('Error fetching conversation for full context:', error.message);
    return null;
  }

  return {
    conversation_id: conversationId,
    channel: conversation.channel_type,
    status: conversation.status,
    messages,
    notes: notes.map(n => n.note),
    tag: conversation.tag,
  };
}

// Tool: get_recent_customer_statuses
// Lightweight sweep across recent conversations for this business —
// tag, status, and notes only, deliberately excludes message content
// to keep this compact for "who's waiting / who went quiet" style
// questions that don't need full transcripts.
async function getRecentCustomerStatuses(businessId, hoursBack = 48) {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const { data: conversations, error } = await supabase
    .from('conversations')
    .select('id, channel_type, status, tag, created_at')
    .eq('business_id', businessId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching recent customer statuses:', error.message);
    return [];
  }

  const results = [];
  for (const conv of conversations) {
    const notes = await getNotes(conv.id);
    results.push({
      conversation_id: conv.id,
      channel: conv.channel_type,
      status: conv.status,
      tag: conv.tag,
      notes: notes.map(n => n.note),
      created_at: conv.created_at,
    });
  }
  return results;
}

// ============================================
// BUSINESS SETTINGS
// Rules/tone/policies configured per business, read on every reply.
// ============================================

async function getBusinessSettings(businessId) {
  const { data, error } = await supabase
    .from('business_settings')
    .select('key, value')
    .eq('business_id', businessId);

  if (error) {
    console.error('Error fetching business settings:', error.message);
    return {};
  }

  // Convert the key/value rows into a simple object for easy use in prompts
  const settings = {};
  for (const row of data) {
    settings[row.key] = row.value;
  }
  return settings;
}

async function getBusinessKnowledge(businessId) {
  const { data, error } = await supabase
    .from('business_knowledge')
    .select('category, content')
    .eq('business_id', businessId);

  if (error) {
    console.error('Error fetching business knowledge:', error.message);
    return [];
  }
  return data;
}

module.exports = {
  updateCustomerName,
  getBusinessByWhatsAppPhoneNumberId,
  getBusinessByInstagramAccountId,
  findOrCreateCustomer,
  getOrCreateActiveConversation,
  updateConversationStatus,
  saveMessage,
  getRecentMessages,
  saveNote,
  getNotes,
  getBusinessSettings,
  getBusinessKnowledge,
  getAwaitingOwnerConversations,
  getConversationById,
  getMostRecentlyPingedConversation,
  setTag,
  getTag,
  getConversationFullContext,
  getRecentCustomerStatuses,
};
