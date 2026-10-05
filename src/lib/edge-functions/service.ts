import 'server-only'
import { z } from 'zod'
import { FUNCTION_HOOK_SECRET_NAME, functionOptionsSchema, functionSlugSchema, functionViewSchema, type FunctionOptions } from './contract'
import { deriveHookSecret, FunctionError, hookSecretDigest, isValidHookSecret, type FunctionSigningContext } from './policy'
import type { FunctionProvider } from './provider'
import { parseSupabaseSecretMetadata } from '../supabase/secret-metadata'
import { functionSourceView } from './source-view'

const rawFunctionSchema = z.object({ id: z.string().min(1).max(200), slug: functionSlugSchema,
  status: z.enum(['ACTIVE', 'REMOVED', 'THROTTLED']), version: z.number().int().nonnegative(), verify_jwt: z.boolean().nullish() })
const rawConfigSchema = z.object({ hook_send_email_enabled: z.boolean(), hook_send_email_uri: z.string().max(2000).nullish(),
  hook_send_email_secrets: z.string().max(2000).nullish(), external_email_enabled: z.boolean().optional() })
type HookConfig = z.infer<typeof rawConfigSchema>
const view = (raw: z.infer<typeof rawFunctionSchema>) => functionViewSchema.parse({ slug: raw.slug, status: raw.status, version: raw.version, verifyJwt: raw.verify_jwt ?? null })
function parseFunction(raw: unknown, slug: string) {
  const parsed = rawFunctionSchema.safeParse(raw)
  if (!parsed.success || parsed.data.slug !== slug) throw new FunctionError('Metadados da função não confirmados para o destino solicitado.', 502)
  return parsed.data
}
function parseConfig(raw: unknown): HookConfig {
  const parsed = rawConfigSchema.safeParse(raw)
  if (!parsed.success) throw new FunctionError('Configuração do hook não pôde ser confirmada.', 502)
  return parsed.data
}
function targetSlug(config: HookConfig, projectRef: string): string | null {
  const prefix = `https://${projectRef}.supabase.co/functions/v1/`
  if (!config.hook_send_email_uri?.startsWith(prefix)) return null
  const parsed = functionSlugSchema.safeParse(config.hook_send_email_uri.slice(prefix.length))
  return parsed.success ? parsed.data : null
}
function secretInstalled(raw: unknown, value: string, rejectConflict = false): boolean {
  const parsed = parseSupabaseSecretMetadata(raw)
  if (parsed === null) throw new FunctionError('Metadados dos segredos da função não confirmados.', 502)
  const installed = parsed.find(row => row.name === FUNCTION_HOOK_SECRET_NAME)
  const matches = installed?.digest === hookSecretDigest(value)
  if (rejectConflict && installed && !matches)
    throw new FunctionError('Já existe outro segredo reservado para o hook. Nenhuma credencial foi sobrescrita. Consulte functions hook status antes de repetir.')
  return matches
}
function hookView(config: HookConfig, projectRef: string, installed: boolean) {
  const slug = targetSlug(config, projectRef)
  return { enabled: config.hook_send_email_enabled, targetSlug: slug, targetMatchesProject: slug !== null, signingSecretConfigured: installed }
}
function assertCompatible(config: HookConfig, uri: string, replaceUri?: string): void {
  if (config.hook_send_email_uri && config.hook_send_email_uri !== uri && config.hook_send_email_uri !== replaceUri)
    throw new FunctionError('Já existe um hook de email com outro destino. A configuração atual foi preservada.')
  if (config.external_email_enabled === false) throw new FunctionError('O provedor de email está desativado. Ative-o antes de configurar o hook.')
}
function unchanged(before: HookConfig, after: HookConfig): boolean {
  return before.hook_send_email_enabled === after.hook_send_email_enabled && before.hook_send_email_uri === after.hook_send_email_uri
    && before.hook_send_email_secrets === after.hook_send_email_secrets && before.external_email_enabled === after.external_email_enabled
}

export async function runFunctions(provider: FunctionProvider, raw: FunctionOptions,
  context: Omit<FunctionSigningContext, 'slug' | 'secretName'>): Promise<unknown> {
  const options = functionOptionsSchema.parse(raw)
  if (options.operation === 'functions-history') {
    if (!provider.artifactHistory) throw new FunctionError('Histórico protegido indisponível neste executor.')
    return provider.artifactHistory(options.slug)
  }
  if (options.operation === 'functions-code') {
    if (!provider.artifact) throw new FunctionError('Código protegido indisponível neste executor.')
    const bundle = await provider.artifact(options.slug, options.version)
    if (bundle.slug !== options.slug || bundle.environment !== options.environment) throw new FunctionError('Artefato pertence a outro destino.')
    return functionSourceView(bundle, options.version)
  }
  if (options.operation === 'functions-list') {
    const parsed = z.array(rawFunctionSchema).max(1000).safeParse(await provider.list())
    if (!parsed.success) throw new FunctionError('Lista de funções não pôde ser confirmada.', 502)
    return { functions: parsed.data.map(view) }
  }
  if (options.operation === 'functions-status') {
    const found = await provider.get(options.slug)
    return { function: found === null ? null : view(parseFunction(found, options.slug)) }
  }
  if (options.operation === 'functions-remove' || options.operation === 'functions-rollback') {
    const before = parseFunction(await provider.get(options.slug), options.slug)
    if (before.version !== options.expectedVersion) throw new FunctionError('A versão mudou. Consulte functions status e refaça a operação.')
    if (options.operation === 'functions-remove') {
      if (!provider.remove || !provider.dependencies) throw new FunctionError('Remoção de funções não está disponível neste executor.')
      if (await provider.dependencies(options.slug) !== 0) throw new FunctionError('A função ainda é referenciada por hook ou job. Trate a dependência antes de remover.')
      const current = parseFunction(await provider.get(options.slug), options.slug)
      if (current.id !== before.id || current.version !== before.version) throw new FunctionError('A função mudou durante a inspeção. Nenhuma remoção foi enviada.')
      await provider.remove(options.slug)
      const observed = await provider.get(options.slug)
      if (observed !== null && parseFunction(observed, options.slug).status !== 'REMOVED') throw new FunctionError('Remoção enviada, mas não confirmada. Consulte functions status antes de repetir.')
      return { slug: options.slug, removed: true, verified: true }
    }
    if (!provider.artifact) throw new FunctionError('Histórico de artefatos não está disponível neste executor.')
    const artifact = await provider.artifact(options.slug, options.version)
    if (artifact.slug !== options.slug || artifact.environment !== options.environment) throw new FunctionError('Artefato pertence a outro destino.')
    const current = parseFunction(await provider.get(options.slug), options.slug)
    if (current.id !== before.id || current.version !== before.version) throw new FunctionError('A função mudou antes da restauração.')
    const restored = parseFunction(await provider.deploy(artifact), options.slug)
    const observed = parseFunction(await provider.get(options.slug), options.slug)
    if (restored.id !== observed.id || restored.version !== observed.version || observed.status !== 'ACTIVE' || observed.verify_jwt !== artifact.verifyJwt) throw new FunctionError('A versão restaurada não foi confirmada.')
    return { function: view(observed), restoredFromVersion: options.version, verified: true, deliveryVerified: false }
  }
  if (options.operation === 'functions-deploy') {
    const { operation: _operation, operationId: _operationId, ...bundle } = options
    void _operation
    void _operationId
    const deployed = parseFunction(await provider.deploy(bundle), options.slug)
    const observed = parseFunction(await provider.get(options.slug), options.slug)
    if (deployed.id !== observed.id || deployed.version !== observed.version || observed.status !== 'ACTIVE' || observed.verify_jwt !== options.verifyJwt)
      throw new FunctionError('Publicação enviada, mas a versão da função não foi confirmada. Consulte functions status antes de repetir.')
    return { function: view(observed), deployed: true, verified: true, deliveryVerified: false }
  }
  const before = parseConfig(await provider.authConfig())
  if (options.operation === 'functions-test') {
    const secret = before.hook_send_email_secrets
    const current = parseFunction(await provider.get(options.slug), options.slug)
    if (targetSlug(before, context.projectRef) !== options.slug || !before.hook_send_email_enabled || !isValidHookSecret(secret)
      || current.version !== options.expectedVersion || current.status !== 'ACTIVE' || current.verify_jwt !== false
      || !secretInstalled(await provider.secrets(), secret)) throw new FunctionError('O ensaio exige a versão atual do hook instalado com assinatura confirmada.')
    if (await provider.probe(options.slug) !== 401 || await provider.probe(options.slug, secret, 'invalid') !== 401
      || await provider.probe(options.slug, secret, 'expired') !== 401 || await provider.probe(options.slug, secret) !== 400)
      throw new FunctionError('O comportamento da assinatura não foi confirmado. Este ensaio não comprova envio de email.')
    const after = parseFunction(await provider.get(options.slug), options.slug)
    if (!unchanged(before, parseConfig(await provider.authConfig())) || after.id !== current.id || after.version !== current.version || after.status !== 'ACTIVE' || after.verify_jwt !== false)
      throw new FunctionError('A função ou o hook mudou durante o ensaio. Resultado não confirmado.')
    return { function: view(after), signatureVerified: true, requests: 4, payload: 'empty_object', deliveryVerified: false }
  }
  if (options.operation === 'functions-hook-status') {
    const secret = before.hook_send_email_secrets
    const installed = targetSlug(before, context.projectRef) !== null && isValidHookSecret(secret) && secretInstalled(await provider.secrets(), secret)
    return { hook: hookView(before, context.projectRef, installed), deliveryVerified: false }
  }
  if (options.operation === 'functions-hook-disable') {
    if (!provider.disableHook || targetSlug(before, context.projectRef) !== options.slug) throw new FunctionError('O hook atual não corresponde à função informada.')
    const current = parseConfig(await provider.authConfig())
    if (!unchanged(before, current)) throw new FunctionError('O hook mudou durante a operação.')
    if (before.hook_send_email_enabled) await provider.disableHook()
    const after = parseConfig(await provider.authConfig())
    if (after.hook_send_email_enabled || !unchanged({ ...before, hook_send_email_enabled: false }, after)) throw new FunctionError('Desativação do hook não foi confirmada.')
    const secret = after.hook_send_email_secrets
    return { hook: hookView(after, context.projectRef, isValidHookSecret(secret) && secretInstalled(await provider.secrets(), secret)), disabled: true, verified: true, deliveryVerified: false }
  }
  const uri = `https://${context.projectRef}.supabase.co/functions/v1/${options.slug}`
  const replaceUri = options.replaceSlug ? `https://${context.projectRef}.supabase.co/functions/v1/${options.replaceSlug}` : undefined
  assertCompatible(before, uri, replaceUri)
  const deployed = parseFunction(await provider.get(options.slug), options.slug)
  if (deployed.status !== 'ACTIVE' || deployed.verify_jwt !== false)
    throw new FunctionError('O hook exige função ativa com JWT do gateway desativado e validação da assinatura Standard Webhooks no código.')
  const previousSecret = before.hook_send_email_secrets
  if (previousSecret && !isValidHookSecret(previousSecret)) throw new FunctionError('A assinatura existente não pode ser reutilizada com segurança. Nenhuma chave foi substituída.')
  if (previousSecret && before.hook_send_email_uri !== uri && before.hook_send_email_uri !== replaceUri) throw new FunctionError('A assinatura existente não está vinculada a esta função. A configuração atual foi preservada.')
  const secret = previousSecret || deriveHookSecret({ ...context, slug: options.slug, secretName: options.secretName })
  // No provider write occurs if its auth configuration has changed while reading the function.
  const current = parseConfig(await provider.authConfig())
  assertCompatible(current, uri, replaceUri)
  if (!unchanged(before, current)) throw new FunctionError('A configuração do hook mudou durante a operação. Consulte functions hook status antes de repetir.')
  const alreadyInstalled = secretInstalled(await provider.secrets(), secret, true)
  if (!alreadyInstalled) await provider.setSecret(options.secretName, secret)
  // Harmless empty objects contain neither a recipient nor an OTP. Acceptance of
  // an invalid signature, or rejection of the valid signature, blocks activation.
  if (await provider.probe(options.slug) !== 401 || await provider.probe(options.slug, secret, 'invalid') !== 401
    || await provider.probe(options.slug, secret, 'expired') !== 401 || await provider.probe(options.slug, secret) !== 400)
    throw new FunctionError('A função ainda não confirmou a assinatura: assinatura ausente, inválida ou expirada deve retornar 401; payload assinado inválido deve retornar 400. O hook não foi habilitado por esta operação. Confira a variável AUTH_SEND_EMAIL_HOOK_SECRET e o status.')
  const ready = parseConfig(await provider.authConfig())
  assertCompatible(ready, uri, replaceUri)
  // Another identical setup may already have converged. A different private key
  // or target always stops the operation instead of silently rotating it.
  const converged = ready.hook_send_email_enabled && ready.hook_send_email_uri === uri && ready.hook_send_email_secrets === secret
  if (!converged && !unchanged(before, ready)) throw new FunctionError('O hook mudou durante a verificação. Consulte functions hook status; a configuração não foi sobrescrita.')
  if (!converged) await provider.configureHook(uri, secret)
  const after = parseConfig(await provider.authConfig())
  const finalFunction = parseFunction(await provider.get(options.slug), options.slug)
  const installed = secretInstalled(await provider.secrets(), secret)
  if (!after.hook_send_email_enabled || after.hook_send_email_uri !== uri || after.hook_send_email_secrets !== secret || !installed
    || finalFunction.id !== deployed.id || finalFunction.version !== deployed.version || finalFunction.status !== 'ACTIVE' || finalFunction.verify_jwt !== false)
    throw new FunctionError('Configuração enviada, mas o resultado final do hook não foi confirmado. Consulte functions hook status antes de repetir; o envio de email ainda não foi testado.')
  return { hook: hookView(after, context.projectRef, true), configured: true, verified: true, signatureVerified: true, deliveryVerified: false }
}
