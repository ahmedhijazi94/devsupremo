/** This is the executable control-plane catalog, separate from optional app
 * scaffold modules in capabilities/. Only shipped entry points are advertised. */
export const ENGINE_PROTOCOL = { version: 2, minimumCli: '1.14.0', localQueue: 2, policyMigration: 28, receiptMigration: 29, approvalMigration: 39, usageMigration: 40 } as const
export const ENGINE_OPERATIONS = [
  { name: 'data-plan', executor: 'database-mutations/server.ts', environments: ['development'], effects: 'read', verification: 'catalog-and-row-hashes', permission: 'data.read' },
  { name: 'data-apply', executor: 'database-mutations/server.ts', environments: ['development'], effects: 'bounded-data-write', verification: 'transaction-receipt', permission: 'data.*' },
  { name: 'auth-role-set', executor: 'database-admin/service.ts', environments: ['development'], effects: 'claims-and-refresh-sessions', verification: 'claims-revision-and-session-revocation', permission: 'auth.roles' },
  { name: 'auth-sessions-revoke', executor: 'database-admin/service.ts', environments: ['development', 'production'], effects: 'refresh-session-revocation', verification: 'session-count', permission: 'auth.sessions' },
  { name: 'auth-invite', executor: 'database-admin/tracked.ts', environments: ['development', 'production'], effects: 'email-invitation-to-exact-recipient', verification: 'provider-acceptance-and-user-readback-not-email-delivery', permission: 'auth.invite' },
  { name: 'auth-provider-configure', executor: 'secret-requests/configuration.ts', environments: ['development', 'production'], effects: 'google-or-github-login-via-secure-form', verification: 'auth-config-readback-not-live-login', permission: 'authenticated-project-owner-or-credentials.use' },
  { name: 'storage', executor: 'project-storage/server.ts', environments: ['development', 'production'], effects: 'bucket-and-object-operations', verification: 'storage-api-readback', permission: 'storage.*' },
  { name: 'integration', executor: 'integrations/server.ts', environments: ['development', 'production'], effects: 'approved-provider-contract', verification: 'provider-specific-receipt', permission: 'integrations.invoke' },
  { name: 'functions', executor: 'edge-functions/server.ts', environments: ['development', 'production'], effects: 'deploy-hook-remove-rollback', verification: 'published-version-and-config', permission: 'functions.*' },
  { name: 'jobs', executor: 'database-jobs/service.ts', environments: ['development', 'production'], effects: 'scheduled-backend-task', verification: 'job-and-run-receipt', permission: 'jobs.*' },
  { name: 'auth', executor: 'database-admin/tracked.ts', environments: ['development', 'production'], effects: 'bounded-user-and-auth-configuration', verification: 'provider-readback-and-operation-receipt', permission: 'auth.*' },
  { name: 'sql-artifacts', executor: 'sql-artifacts/server.ts', environments: ['development'], effects: 'versioned-migration-through-local-executor', verification: 'materialized-digest-and-migration-history', permission: 'schema.migrate' },
  { name: 'secrets-apply', executor: 'credentials/device.ts', environments: ['development', 'production'], effects: 'deliver-protected-reference', verification: 'provider-fingerprint-or-specific-readback', permission: 'credentials.use' },
  { name: 'integration-propose', executor: 'provider-connections/proposals.ts', environments: ['development', 'production'], effects: 'prepare-exact-provider-contract', verification: 'owner-approved-contract-and-vault-reference', permission: 'integrations.configure' },
  { name: 'approval-status', executor: 'backend-operations/approvals.ts', environments: ['development', 'production'], effects: 'read', verification: 'owner-project-operation-binding', permission: 'authenticated-project-owner' },
  { name: 'usage', executor: 'backend-observability/server.ts', environments: ['development', 'production'], effects: 'read-and-save-hourly-observation', verification: 'provider-observation-with-availability', permission: 'data.read' },
  { name: 'runtime-update', executor: 'packages/cli/src/runtime-release.ts', environments: ['development'], effects: 'transactional-managed-tools-update', verification: 'official-candidate-digest-and-active-worker-version', permission: 'engine.update' },
] as const

export function engineCatalog() {
  return { protocol: ENGINE_PROTOCOL, operations: ENGINE_OPERATIONS,
    limitations: ['A capacidade precisa estar autorizada para o projeto e ambiente.',
      'Produção só está disponível nas operações que declaram esse ambiente.',
      'Publicação da função, aceitação da requisição e efeito externo são provas diferentes.',
      'Uma aprovação pontual exige retomar o mesmo ID e conteúdo; não altera a política permanente.',
      'Resultado incerto nunca autoriza repetição automática de uma escrita.',
      'Uso histórico é coletado nas consultas; ausência de dados não significa consumo zero.',
      'O executor local precisa estar disponível; não executa com o computador desligado.'],
    authorizationUrlSection: 'Automação', secretEntry: 'Supremo secure form; values never returned to agent' }
}
