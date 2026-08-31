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

-- Receber (subscribe) mensagens só do próprio canal.
CREATE POLICY "runtime channel receive (own user)"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (realtime.topic() = 'runtime:' || (SELECT auth.uid())::text);

-- Publicar (broadcast) só no próprio canal. O companion publica eventos aqui;
-- a web, na prática, só recebe (comandos vêm do servidor via service_role).
CREATE POLICY "runtime channel send (own user)"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (realtime.topic() = 'runtime:' || (SELECT auth.uid())::text);
