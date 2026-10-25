-- Migration 055: let one account hold several roles.
--
-- users.role stays the role the account signed up with (and the dashboard it
-- opens on). users.roles lists every role the account is registered for, so a
-- tenant can also be a landlord or a whistleblower and switch dashboards.

ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';

UPDATE users SET roles = ARRAY[role] WHERE cardinality(roles) = 0;
