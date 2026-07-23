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
    .insert({ business_id: businessId })
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
};
