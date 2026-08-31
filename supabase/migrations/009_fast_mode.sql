-- Modo rápido, por projeto.
--
-- Rápido como Lovable, seguro sempre. A segurança por ESTRUTURA (RLS obrigatório
-- em toda tabela, policy com auth.uid(), guard de SQL, nada de segredo no
-- código) continua valendo no write, instantânea. O modo rápido só adia os
-- testes LENTOS (unit, E2E) como gate de merge — eles ainda rodam e reportam.
--
-- fast_mode_rls decide o caso sensível: 'block' mantém o teste de isolamento
-- obrigatório mesmo no modo rápido (mais seguro); 'warn' deixa ele só avisar
-- (mais rápido, um vazamento pode chegar ao preview até você ver).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS fast_mode BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS fast_mode_rls TEXT NOT NULL DEFAULT 'block'
    CHECK (fast_mode_rls IN ('block', 'warn'));
