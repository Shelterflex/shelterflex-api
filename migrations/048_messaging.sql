-- Migration 048: landlord↔tenant messaging service
-- Creates conversations and messages tables with participant-based access control.

-- conversations: a thread between two or more users, optionally scoped to a listing or deal
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID        NULL,
  deal_id         UUID        NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- conversation_participants: enforces the two-party access model
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID    NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id         TEXT    NOT NULL,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

-- messages: individual messages within a conversation
CREATE TABLE IF NOT EXISTS messages (
  message_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id       TEXT        NOT NULL,
  body            TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  read_by         TEXT[]      NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient participant and message lookups
CREATE INDEX IF NOT EXISTS idx_conversation_participants_user_id
  ON conversation_participants(user_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_created_at
  ON messages(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_listing_id
  ON conversations(listing_id);

CREATE INDEX IF NOT EXISTS idx_conversations_deal_id
  ON conversations(deal_id);

-- Trigger to keep conversations.updated_at in sync when new messages arrive
CREATE OR REPLACE FUNCTION update_conversation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations SET updated_at = NOW() WHERE conversation_id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_update_conversation ON messages;
CREATE TRIGGER trg_messages_update_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION update_conversation_updated_at();
