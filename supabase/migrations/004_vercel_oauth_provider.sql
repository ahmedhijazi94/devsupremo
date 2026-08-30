-- ============================================================
-- SUPREMO — Migration 004
--
-- Idempotente. A conexão da Vercel passou a usar OAuth, e o CHECK de
-- provider em oauth_states só aceitava github e supabase.
-- ============================================================

ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_provider_check;

ALTER TABLE oauth_states
  ADD CONSTRAINT oauth_states_provider_check
  CHECK (provider IN ('github', 'supabase', 'vercel'));

-- ============================================================
-- VERIFICAÇÃO — deve devolver 1 linha "ok"
-- ============================================================
SELECT 'provider vercel aceito' AS item,
       CASE WHEN pg_get_constraintdef(oid) LIKE '%vercel%'
            THEN 'ok' ELSE 'FALTANDO' END AS status
FROM pg_constraint
WHERE conname = 'oauth_states_provider_check';
