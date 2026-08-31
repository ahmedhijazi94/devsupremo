-- Pedidos de secret do agente.
--
-- Quando o agente vai integrar uma API externa, ele NÃO escreve a chave no
-- código nem a recebe — ele registra aqui um PEDIDO ("preciso de LIVELO_API_KEY
-- para chamar a Livelo"). O Supremo mostra um campo para o dono preencher, e o
-- valor vai direto para a env var na Vercel. O agente lê em process.env em
-- tempo de execução e nunca vê o segredo.
--
-- Repare: esta tabela guarda só o PEDIDO (nome, descrição, status). O VALOR
-- jamais é gravado aqui — ele existe só como env var encriptada na Vercel.

CREATE TABLE IF NOT EXISTS secret_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  -- Nome da env var, ex.: LIVELO_API_KEY (ou NEXT_PUBLIC_... se for público).
  name text NOT NULL,
  -- Por que o agente precisa, para o dono saber o que está entregando.
  description text,
  -- true = secret (campo mascarado); false = config pública.
  is_secret boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_secret_requests_project
  ON secret_requests (project_id);

ALTER TABLE secret_requests ENABLE ROW LEVEL SECURITY;

-- Só o dono do projeto vê e mexe nos próprios pedidos.
CREATE POLICY "secret_requests_owner" ON secret_requests
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
