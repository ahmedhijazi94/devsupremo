-- Identidade própria por companion/dispositivo.
--
-- O companion NÃO usa a sessão do usuário principal (esse JWT authenticated
-- poderia tocar o que as RLS normais do usuário permitem). Cada companion ganha
-- um usuário Supabase Auth DEDICADO, com app_metadata server-managed dizendo que
-- é um companion e de quem. A RLS do Realtime (011) escopa ao owner; as demais
-- tabelas negam essa identidade por padrão (auth.uid() do companion != user_id
-- do dono). O vínculo real dono↔companion mora AQUI, não só no JWT — e dá pra
-- revogar um companion sem derrubar a sessão web.

CREATE TABLE IF NOT EXISTS companion_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  -- O usuário Supabase Auth dedicado deste companion (identidade própria).
  auth_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  -- Chave estável gerada na instalação do companion (uma por dono+máquina).
  device_key text NOT NULL,
  device_label text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, device_key)
);

CREATE INDEX IF NOT EXISTS idx_companion_devices_owner ON companion_devices (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_companion_devices_auth ON companion_devices (auth_user_id);

ALTER TABLE companion_devices ENABLE ROW LEVEL SECURITY;

-- Só o DONO gerencia seus companions. A própria identidade do companion
-- (auth.uid() = auth_user_id) é negada aqui — não vê nem lista os devices.
CREATE POLICY "companion_devices_owner" ON companion_devices
  FOR ALL
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);
