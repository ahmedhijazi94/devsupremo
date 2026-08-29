// Chave determinística só para os testes. Nunca usada fora deles.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  '0'.repeat(64)
