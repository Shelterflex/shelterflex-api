/**
 * Messaging model types for the landlord↔tenant messaging service.
 *
 * A Conversation is a thread between two participants (landlord + tenant),
 * optionally scoped to a specific listing or deal.  Messages belong to a
 * conversation and carry sender info, body, timestamps, and a set of
 * user-ids that have read the message.
 */

// ── Conversation ─────────────────────────────────────────────────────────────

export interface Conversation {
  conversationId: string
  /** Participant user-ids — always at least two entries for a valid thread. */
  participantIds: string[]
  /** Display name per participant, resolved from userStore (populated on list/get views). */
  participants?: { userId: string; name: string }[]
  /** Optional listing this conversation is anchored to. */
  listingId?: string
  /** Optional deal this conversation is anchored to. */
  dealId?: string
  createdAt: Date
  updatedAt: Date
  /** Latest message in the conversation (populated on list views). */
  lastMessage?: Message
  /** Number of messages the requesting user has not yet read. */
  unreadCount?: number
}

export interface CreateConversationInput {
  /** Both participant user-ids must be provided. */
  participantIds: [string, string]
  listingId?: string
  dealId?: string
}

// ── Message ───────────────────────────────────────────────────────────────────

export interface Message {
  messageId: string
  conversationId: string
  senderId: string
  /** Sender's display name, resolved from userStore. */
  senderName?: string
  body: string
  /** Set of user-ids who have read this message. */
  readBy: string[]
  createdAt: Date
  updatedAt: Date
}

export interface CreateMessageInput {
  conversationId: string
  senderId: string
  body: string
}

// ── Pagination ────────────────────────────────────────────────────────────────

export interface MessagePage {
  messages: Message[]
  /**
   * Cursor pointing to the oldest message returned.
   * Pass as `before` on the next call to fetch the preceding page.
   */
  nextCursor: string | null
  total: number
}
