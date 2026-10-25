-- Allow a 'whistleblower' role on users.
--
-- A whistleblower-only account reports vacant apartments and never rents
-- through Shelterflex, so it gets no tenant dashboard. It is deliberately not
-- the legacy 'agent' role, which the API treats as privileged.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('tenant', 'landlord', 'agent', 'admin', 'inspector', 'whistleblower'));
