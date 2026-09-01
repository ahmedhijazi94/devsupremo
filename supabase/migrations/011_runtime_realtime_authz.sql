-- Autorização do canal de runtime (Supabase Realtime privado).
--
-- O companion e a web trocam comandos/eventos por um canal privado
-- `runtime:<userId>`. Estas policies garantem que cada usuário só entra no
-- PRÓPRIO canal — ninguém escuta nem publica no runtime de outro. É o
-- isolamento do canal, no mesmo espírito do RLS do resto.
--
-- O servidor (service_role) faz broadcast de comandos ignorando RLS — por isso
-- "comando privilegiado vem pelo Supremo", não do navegador.
--
-- Requer: Realtime Authorization habilitado no projeto Supabase.

-- O "dono" do canal desta identidade: o próprio usuário (sessão web) OU o
-- owner_user_id do companion, lido do app_metadata (server-managed, confiável —
-- nunca user_metadata). Assim a sessão web normal e a identidade dedicada do
-- companion caem no MESMO canal runtime:<owner>, sem o companion herdar acesso a
-- mais nada (as outras tabelas negam essa identidade por padrão via auth.uid()).
--
-- Receber (subscribe) só do canal do dono.
CREATE POLICY "runtime channel receive (owner scope)"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.topic() = 'runtime:' ||
      COALESCE(auth.jwt() -> 'app_metadata' ->> 'owner_user_id', (auth.uid())::text)
  );

-- Publicar (broadcast) só no canal do dono. O companion publica eventos; a web,
-- na prática, só recebe (comandos vêm do servidor via service_role).
CREATE POLICY "runtime channel send (owner scope)"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    realtime.topic() = 'runtime:' ||
      COALESCE(auth.jwt() -> 'app_metadata' ->> 'owner_user_id', (auth.uid())::text)
  );
