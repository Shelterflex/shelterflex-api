-- Allow the 'admin' and 'inspector' roles on users.
--
-- The auth middleware and several routes (inspectorJobs, landlordProperties,
-- requireAdmin) already branch on user.role === 'admin' / 'inspector', but the
-- CHECK constraint from 005_auth_tables.sql only permitted tenant/landlord/agent,
-- so such a user could never be stored.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('tenant', 'landlord', 'agent', 'admin', 'inspector'));
