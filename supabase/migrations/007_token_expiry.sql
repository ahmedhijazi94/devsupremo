-- Renovação de token OAuth.
--
-- O GitHub App emite access token que expira em 8 horas e devolve um refresh
-- token (válido por meses). O callback guardava o refresh, mas nada o usava:
-- passadas 8 horas, todo acesso ao GitHub morria com "Bad credentials" — aba
-- Código, atualização de base, escrita do agente. O Supabase tem o mesmo
-- desenho (access de 1 hora + refresh).
--
-- Esta coluna guarda quando o access token expira, para renovar sob demanda,
-- só quando falta pouco — em vez de renovar a cada chamada (o refresh rotaciona
-- e não convém gastar à toa) ou nunca (o que quebra tudo depois do prazo).

ALTER TABLE github_accounts
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

ALTER TABLE supabase_accounts
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
