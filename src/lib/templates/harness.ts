import {
  BROAD_FILE_COUNT,
  ENV_BUILD_FAILURE_PATTERNS,
  FULL_PATTERNS,
  NEXT_TSCONFIG_TYPES_GLOB_RE,
  QUICK_PATTERNS,
  SECURITY_PATTERNS,
  serializePatterns,
} from './verify-classifier'

/**
 * Local dev harness gerado no scaffold — a "velocidade durante o dev".
 *
 * Emite um `verify` adaptativo (QUICK/SECURITY/FULL escolhido pelo git diff),
 * `setup:local` idempotente, e git hooks. As REGRAS do verify vêm das mesmas
 * constantes do classificador do Supremo (serializadas), então o que o Supremo
 * testa é exatamente o que roda na máquina do dev — sem lógica duplicada à mão.
 *
 * Fonte ÚNICA de testes: uma pasta `tests/` só, usada por dev, hooks e CI.
 */

/** Scripts que o harness contribui ao package.json do projeto gerado. */
export function harnessPackageScripts(): Record<string, string> {
  return {
    typecheck: 'tsc --noEmit',
    verify: 'node scripts/verify.mjs',
    'verify:quick': 'node scripts/verify.mjs quick',
    'verify:security': 'node scripts/verify.mjs security',
    'verify:full': 'node scripts/verify.mjs full',
    'setup:local': 'node scripts/setup-local.mjs',
    'local:start': 'supabase start',
    'local:stop': 'supabase stop',
    // v3.1 — preview PERSISTENTE (infra da sessão, não processo do turno).
    'preview:ensure': 'node scripts/preview.mjs ensure',
    'preview:status': 'node scripts/preview.mjs status',
    'preview:stop': 'node scripts/preview.mjs stop',
    // v3.1 item 4 — checkpoint LOCAL (o agente só faz isto ao concluir um pedido)
    // e o checkpoint daemon (push/PR assíncronos; o agente NUNCA faz git push).
    // A CLI acompanha o projeto e é resolvida localmente pelo PATH do npm.
    checkpoint: 'supremo checkpoint',
    'daemon:ensure': 'supremo daemon --ensure',
    'daemon:status': 'supremo daemon --status',
    'daemon:stop': 'supremo daemon --stop',
    // Diagnóstico agregado (v3.1 finalização) — não é para o dev rodar no dia a
    // dia; a UI do Supremo (Histórico) é o lugar humano. JSON machine-readable.
    'supremo:status': 'node scripts/supremo-status.mjs',
    // Preflight local de retomada (v3.4) — mesmo script, religa o que morreu
    // (preview:ensure/daemon:ensure) e imprime o status final. Antes era só
    // "primeiro pedido da sessão"; agora roda ANTES DE TODO pedido que muda
    // código — 100% local (pid do daemon lido direto, sem npx no caminho
    // saudável), custo próximo de zero quando já está tudo de pé.
    'supremo:resume': 'node scripts/supremo-status.mjs --ensure',
    // Sincronização entre máquinas (v3.3, seção 31) — política PRÓPRIA, SÓ no
    // primeiro pedido da sessão (independente de supremo:resume acima, que
    // agora roda todo pedido). Checagem leve (um SELECT, nunca GitHub),
    // timeout curto embutido; fast-forward automático só quando seguro. A
    // CLI vem por npx, como checkpoint/daemon acima.
    sync: 'supremo sync',
    'security:audit': 'node scripts/security-audit.js --deep --strict',
    'security:report': 'node scripts/security-audit.js --report',
  }
}

/**
 * (PURO) Decisão do supervisor de preview a partir do estado observado — testável
 * sem I/O. `reuse` = há UMA instância viva e saudável; `restart` = processo vivo
 * mas não responde (zumbi) → matar e subir; `start` = nada rodando → subir.
 *
 * Pré-condição que torna isto SEGURO (ver `pickFreePreviewPort` + bug real do
 * E2E abaixo): `healthy` só pode vir de um health-check contra uma porta que o
 * supervisor CONFIRMOU livre antes de subir o servidor ali (persistida em
 * `.supremo/preview.port`). TCP só permite UM listener por porta — então, se a
 * porta era livre no instante em que subimos nosso processo, quem responde
 * nela depois só pode ser o NOSSO processo (nunca um app alheio). O bug real
 * era outro: `previewSupervisorScript()` subia o dev server DIRETO na porta
 * configurada sem checar se já estava ocupada — se estivesse (outro app já
 * rodando ali), o health-check via HTTP respondia "saudável" usando a
 * resposta do processo ALHEIO, um falso positivo, enquanto o processo que
 * `ensure()` de fato acabara de subir podia morrer ou migrar de porta sem que
 * ninguém percebesse.
 */
export function decidePreviewAction(state: {
  pidAlive: boolean
  healthy: boolean
}): 'reuse' | 'restart' | 'start' {
  if (state.pidAlive && state.healthy) return 'reuse'
  if (state.pidAlive && !state.healthy) return 'restart'
  return 'start'
}

/**
 * (PURA) Escolhe a porta para um start fresco do preview: tenta a porta
 * configurada do projeto primeiro; se ocupada, sobe sequencialmente até achar
 * uma livre dentro de `span`. `null` = nenhuma porta livre no intervalo — o
 * supervisor deve falhar CLARAMENTE (stderr + exit code != 0), nunca fingir
 * sucesso apontando pra uma porta que não é dele. `isFree` é injetado (I/O
 * real no script gerado é um bind-probe via `node:net`; aqui é testável sem
 * tocar rede nenhuma).
 */
export function pickFreePreviewPort(
  configuredPort: number,
  isFree: (port: number) => boolean,
  span = 20,
): number | null {
  for (let port = configuredPort; port < configuredPort + span; port++) {
    if (isFree(port)) return port
  }
  return null
}

/**
 * (PURA) Classifica o resultado de checar se um pid rastreado está vivo via
 * `process.kill(pid, 0)`. Só `ESRCH` prova que o processo NÃO existe mais.
 * `EPERM` (comum em sandboxes — ex.: Codex — que podem barrar sinalizar um
 * processo mesmo que ele exista e esteja saudável, por rodar em contexto
 * isolado) ou QUALQUER outro erro NÃO prova que morreu — fica `'unknown'`.
 *
 * BUG REAL (E2E): EPERM era tratado como "morto". `ensure()` perdia o rastro
 * de uma instância saudável (pid vivo em :3001) e subia outra por cima (pid
 * novo em :3000), que morreu com `listen EPERM` — sobrescrevendo o estado da
 * antiga, que continuava rodando e saudável, agora órfã e sem rastro.
 */
export function classifyPidSignalError(code: string | null | undefined): 'dead' | 'unknown' {
  return code === 'ESRCH' ? 'dead' : 'unknown'
}

/**
 * (PURA) Classifica o erro (`err.code`, ou `null`/`undefined` se o bind teve
 * sucesso) de uma tentativa de bind numa porta/host — decide o que isso
 * prova sobre a porta. Só `EADDRINUSE` prova ocupação real. Códigos que só
 * dizem "essa família de endereço não existe nesta máquina" (IPv6 desligado,
 * por exemplo) não provam NADA sobre a porta — `'skip'` (a varredura ignora
 * esse host, sem contar nem como ocupado nem como livre). QUALQUER outro
 * erro (ex.: `EPERM` — bind restrito por um sandbox, como o do Codex) é
 * INDETERMINADO e NUNCA pode virar prova de porta livre — bug real do E2E:
 * um erro assim era tratado como "bind ok, porta livre". Tratado como
 * `'busy'` (conservador): melhor procurar outra porta do que arriscar subir
 * por cima de algo que não conseguimos verificar.
 */
export function classifyBindProbe(errorCode: string | null | undefined): 'free' | 'busy' | 'skip' {
  if (!errorCode) return 'free'
  if (errorCode === 'EADDRINUSE') return 'busy'
  const ADDRESS_FAMILY_UNAVAILABLE = [
    'EADDRNOTAVAIL',
    'EAFNOSUPPORT',
    'EPROTONOSUPPORT',
    'ENOTSUP',
    'EOPNOTSUPP',
    'EINVAL',
  ]
  if (ADDRESS_FAMILY_UNAVAILABLE.includes(errorCode)) return 'skip'
  return 'busy'
}

/**
 * (PURA) Um heartbeat de saúde do preview (teste-v3-17) só conta se foi
 * escrito DENTRO da janela de frescor — mais velho que isso, o processo
 * que o escrevia pode ter morrido/travado, e confiar nele seria um falso
 * positivo (a mesma classe de risco que um pidfile órfão). `nowMs`
 * injetado (I/O real é `Date.now()`) — testável sem esperar tempo de
 * verdade. Um `checkedAt` no FUTURO (relógio incoerente/dado corrompido)
 * também não é fresco — fail-closed por padrão.
 */
export function isHeartbeatFresh(checkedAt: number, nowMs: number, staleMs: number): boolean {
  if (!Number.isFinite(checkedAt)) return false
  const age = nowMs - checkedAt
  return age >= 0 && age <= staleMs
}

/**
 * (PURA) Um heartbeat só pode ser CONFIADO se descrever a instância que
 * temos rastreada AGORA — nunca só por estar fresco e "healthy: true"
 * (teste-v3-17b). Sem isto, um pid reaproveitado pelo SO depois que o
 * processo original morre faria um heartbeat velho (mas ainda dentro do
 * TTL, escrito por um writer que ainda não notou a morte) mentir como se
 * fosse a instância nova. Por isso exige, TODOS ao mesmo tempo:
 * `healthy === true`; fresco (`isHeartbeatFresh`); o `pid` do heartbeat
 * bate com o pid rastreado AGORA; o `instanceId` do heartbeat bate com o
 * token da instância registrada AGORA (nunca aceito se não houver um
 * token registrado); e o pid ainda é considerado vivo/presente
 * (`current.pidAlive`). `heartbeat`/`current.instanceId` nulos (arquivo
 * ausente, ou nenhuma instância registrada ainda) nunca são confiados —
 * fail-closed por padrão.
 */
export function isHeartbeatTrusted(
  heartbeat: { healthy: boolean; checkedAt: number; pid: number; instanceId: string } | null,
  current: { pid: number; instanceId: string | null; pidAlive: boolean },
  nowMs: number,
  staleMs: number,
): boolean {
  if (!heartbeat) return false
  if (heartbeat.healthy !== true) return false
  if (!isHeartbeatFresh(heartbeat.checkedAt, nowMs, staleMs)) return false
  if (heartbeat.pid !== current.pid) return false
  if (!current.instanceId || heartbeat.instanceId !== current.instanceId) return false
  if (!current.pidAlive) return false
  return true
}

/**
 * `scripts/preview.mjs` — supervisor determinístico do dev server (v3.1).
 *
 * O preview é INFRAESTRUTURA da sessão/projeto, não um processo do turno do agente.
 * Por isso o `next dev` sobe DESACOPLADO (detached + unref): sobrevive ao fim do
 * comando/turno, ao commit/push e ao verify. `ensure` mantém UMA instância saudável
 * (reusa / reinicia zumbi / inicia), em porta estável, e espera readiness.
 *
 * OWNERSHIP DA PORTA (fix do E2E real: porta 3000 já ocupada por outro app
 * fazia `preview:ensure` reportar "saudável" usando a resposta do processo
 * ALHEIO, e salvar o pid de um processo nosso que podia morrer/migrar de
 * porta sem ninguém notar). Antes de subir um processo NOVO, o supervisor
 * SEMPRE confirma via bind-probe (`node:net`, não HTTP; em IPv4 E IPv6 —
 * loopback e wildcard das duas famílias, ver `isPortFree` — um foreign server
 * só no wildcard IPv6 `::` já escapou de um probe IPv4-only num E2E real)
 * que a porta está livre; se a configurada estiver ocupada por outra coisa, procura a próxima
 * livre (`pickPort`, mesmo algoritmo de `pickFreePreviewPort`) e persiste a
 * porta REAL usada em \`.supremo/preview.port\` — \`status\`/\`ensure\` seguintes
 * sempre checam essa porta persistida, nunca cegamente a configurada. Se
 * nenhuma porta livre existir no intervalo, falha alto e claro (nunca declara
 * sucesso). Uma instância JÁ rastreada (pid vivo OU não-sinalizável — ver
 * abaixo) só é reusada depois de responder saudável NA PORTA PERSISTIDA — e
 * como essa porta só foi ocupada por nós (confirmada livre antes do bind),
 * TCP garante que ninguém mais pode estar respondendo ali: não há como um
 * processo alheio ser confundido com o nosso nesse caminho.
 *
 * SANDBOX (fix do E2E real: `preview:ensure` dentro do sandbox do Codex).
 * Um preview saudável sobrevivia entre "prompts" (pid antigo, porta antiga),
 * mas o prompt seguinte rodava em outro contexto de sandbox onde
 * `process.kill(pid, 0)` no pid antigo dava **EPERM** (não `ESRCH`) — o
 * processo seguia vivo e saudável, só não era mais SINALIZÁVEL daquele
 * contexto. O supervisor tratava EPERM como "morto", subia uma instância
 * NOVA (que morreu com `listen EPERM` — outra restrição do sandbox), e já
 * tinha sobrescrito `.supremo/preview.pid`/`.port` pro pid/porta mortos ANTES
 * de confirmar que a nova instância respondia — perdendo o rastro da antiga,
 * que seguia rodando (órfã, sem ninguém apontando pra ela). Fix, em duas
 * partes: (1) `pidState`/`alive` (ver `classifyPidSignalError`) só tratam um
 * pid como morto com `ESRCH` — `EPERM`/qualquer outro erro vira `'unknown'`,
 * que `ensure()` trata como "pode estar vivo, confirma pela porta"; (2)
 * `.supremo/preview.pid`/`.port` só são escritos DEPOIS que uma candidata
 * nova passa no healthcheck — uma tentativa que falha NUNCA sobrescreve o
 * estado anterior, saudável ou não.
 *
 * REDE TAMBÉM É POR-COMANDO NO SANDBOX (E2E real, teste-v3-17 — a mesma
 * causa do bug do SANDBOX acima, só que pra rede em vez de sinal de pid):
 * `next dev` fica de pé num processo desacoplado, criado UMA vez; mas
 * `health()` era chamado por um subprocesso NOVO a cada `supremo:resume` —
 * e, nesse sandbox, CADA comando do agente ganha seu próprio namespace de
 * rede, isolado de onde o `next dev` de verdade está escutando. Daemon
 * healthy, preview `running=true` (PID, que já é tolerante), mas
 * `healthy=false` pra sempre — mesmo com o browser do host (caminho de rede
 * PRÓPRIO, persistente) respondendo 200 no MESMO instante. Testar mais
 * famílias de endereço (v3.4.5) não ajuda: nenhum endereço, de nenhuma
 * família, DENTRO desse namespace isolado, alcança o processo real.
 *
 * Fix: a VERIFICAÇÃO de saúde passa a ser feita por um processo
 * CO-LOCALIZADO com o `next dev` — um "heartbeat" desacoplado, subido no
 * MESMO comando que confirmou o servidor saudável pela 1ª vez (mesmo
 * namespace, garantido), que sonda `health()` periodicamente e persiste o
 * resultado em `.supremo/preview.health.json`. Qualquer comando FUTURO
 * (`status`/`ensure`, em QUALQUER namespace) primeiro confia nesse heartbeat
 * — só cai pro probe HTTP direto (o caminho de sempre, ainda funciona em
 * ambientes sem esse isolamento) se o heartbeat estiver ausente ou velho
 * demais (`HEALTH_STALE_MS`) pra confiar. PID vivo sozinho continua não
 * bastando, porta aberta sozinha continua não bastando — o heartbeat só
 * escreve `healthy: true` depois de um GET de verdade, na porta certa, que
 * respondeu; e para de escrever (o arquivo fica velho e some) assim que o
 * processo que ele acompanha morre — fail-closed intacto.
 *
 * IDENTIDADE DA INSTÂNCIA (teste-v3-17b — pid reuse). Um heartbeat só por
 * `{healthy, checkedAt}` não prova que descreve o processo que TEMOS
 * rastreado agora: o SO pode reaproveitar um pid depois que o processo
 * original morre, e um heartbeat "fresco" nesse instante mentiria. Todo
 * heartbeat carrega o `pid` e um `instanceId` (token aleatório gerado
 * quando a instância sobe) de quem o escreveu; só é aceito se AMBOS
 * baterem com `.supremo/preview.pid`/`.supremo/preview.instance` — o que
 * está registrado AGORA, não o que foi lido há alguns segundos — e se o
 * pid ainda for considerado vivo (ver `isHeartbeatTrusted`). `ensure()`
 * invalida (remove) o heartbeat e o token da instância anterior no
 * INSTANTE em que decide `restart` (antes mesmo da candidata nova
 * existir), e `stop()` faz o mesmo — nunca sobra um heartbeat órfão
 * apontando pra uma instância que já não é a registrada. O próprio
 * heartbeat writer para de escrever (e não limpa o arquivo de quem o
 * substituiu) assim que percebe que já não é mais a instância registrada.
 * A escrita do arquivo é atômica (tmp + rename) — uma leitura concorrente
 * nunca pega JSON parcial/truncado.
 */
export function previewSupervisorScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo (v3.1) — supervisor do preview. NÃO rode 'next dev' à mão:
//   node scripts/preview.mjs ensure     → garante 1 preview saudável (reusa/inicia)
//   node scripts/preview.mjs status     → estado (json)
//   node scripts/preview.mjs stop       → para
//   node scripts/preview.mjs __heartbeat <pid> <port> <instanceId>  → uso INTERNO
//                                          (ver ensure()); nunca rode isto à mão.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import http from 'node:http'

const ROOT = process.cwd()
const DIR = join(ROOT, '.supremo')
const PIDFILE = join(DIR, 'preview.pid')
const PORTFILE = join(DIR, 'preview.port') // porta REAL em uso (pode diferir de PORT — ver pickPort)
const LOG = join(DIR, 'preview.log')
const HEALTH_FILE = join(DIR, 'preview.health.json') // heartbeat co-localizado — ver ensure()/teste-v3-17
const INSTANCEFILE = join(DIR, 'preview.instance') // token da instância ATUAL — ver teste-v3-17b (pid reuse)
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 3000) // porta PREFERIDA do projeto
const PORT_SEARCH_SPAN = 20 // quantas portas tentar acima da preferida antes de desistir
const SCRIPT_PATH = 'scripts/preview.mjs' // caminho fixo do próprio gerado — usado só pra subir o heartbeat

function readPid() {
  try { return Number(readFileSync(PIDFILE, 'utf8').trim()) || null } catch { return null }
}
function readPort() {
  try {
    const n = Number(readFileSync(PORTFILE, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}
// Mesma classificação pura de harness.classifyPidSignalError (mantidas em
// sincronia). Só ESRCH prova que o processo não existe mais — EPERM (comum
// em sandboxes, ex.: Codex) ou qualquer outro erro NÃO prova que morreu.
function pidState(pid) {
  if (!pid) return 'dead'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    return (err && err.code) === 'ESRCH' ? 'dead' : 'unknown'
  }
}
// 'unknown' (não dá pra confirmar, mas também não dá pra provar que morreu)
// conta como vivo pra decide() — a prova de verdade vem do healthcheck na
// porta rastreada (ver ensure()), não de conseguir sinalizar o pid.
function alive(pid) {
  return pidState(pid) !== 'dead'
}
// Bind-probe real (node:net) — NUNCA HTTP: uma porta ocupada por um serviço
// não-HTTP (ou por um app que não responde em '/') ainda conta como ocupada.
// É isto (checar ANTES de subir, nunca confiar em quem já responde lá) que
// impede o falso positivo do bug real: nunca subimos por cima de outro app.
//
// BUG REAL (E2E, achado que a v1 deste fix não cobria): o probe testava SÓ
// IPv4 (127.0.0.1). Um \`python3 -m http.server\` que ocupa o wildcard IPv6
// (\`::\`) passa batido nesse probe — a porta parece livre, o preview persiste
// ela, e o dev server real (que, sem host explícito, também tenta bindar em
// IPv6 quando disponível — é o padrão do próprio Node) morre ao colidir de
// verdade. Fix: testa TODOS os endereços relevantes pra "esta porta está
// livre pra servir o preview" — loopback e wildcard, IPv4 E IPv6 — e só
// declara livre se NENHUM deles estiver ocupado.
//
// Mesma classificação pura de harness.classifyBindProbe (mantidas em
// sincronia). QUALQUER erro fora de EADDRINUSE/família-indisponível (ex.:
// EPERM — bind restrito por sandbox) é indeterminado e NUNCA vira prova de
// porta livre — outro bug real do E2E era exatamente esse.
function classifyBindError(code) {
  if (!code) return 'free'
  if (code === 'EADDRINUSE') return 'busy'
  const ADDRESS_FAMILY_UNAVAILABLE = ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL']
  if (ADDRESS_FAMILY_UNAVAILABLE.includes(code)) return 'skip'
  return 'busy'
}
function tryBind(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }
    tester.once('error', (err) => finish(classifyBindError(err && err.code)))
    tester.once('listening', () => tester.close(() => finish('free')))
    try {
      tester.listen(port, host)
    } catch (err) {
      finish(classifyBindError(err && err.code))
    }
  })
}
// HOST (IPv4) + wildcards de IPv4/IPv6 + loopback IPv6 — compatível com
// qualquer host em que o \`npm run dev\` real (subido sem --host explícito)
// venha a bindar, seja qual for o framework.
const PROBE_HOSTS = [HOST, '0.0.0.0', '::', '::1']
async function isPortFree(port) {
  for (const host of PROBE_HOSTS) {
    if ((await tryBind(port, host)) === 'busy') return false
  }
  return true
}
// Mesmo algoritmo puro de harness.pickFreePreviewPort (mantidos em sincronia).
async function pickPort(configuredPort, span = PORT_SEARCH_SPAN) {
  for (let port = configuredPort; port < configuredPort + span; port++) {
    if (await isPortFree(port)) return port
  }
  return null
}
// BUG REAL (E2E, teste-v3-16): o healthcheck testava SÓ HOST (127.0.0.1) —
// daemon saudável, preview \`running=true\`, mas o preflight reportava
// \`healthy=false\` e fail-closed, enquanto \`curl localhost:PORTA\`/o browser
// do host respondiam 200 no MESMO instante. Causa: em sandboxes cujo
// netstack não é dual-stack de verdade (comum fora do macOS — bindv6only
// de kernel, ou a implementação de rede do próprio sandbox), um servidor
// que bindou no wildcard \`::\` pode aceitar \`::1\`/\`localhost\` e recusar
// \`127.0.0.1\` — mesma classe de problema que \`PROBE_HOSTS\` acima já trata
// pro bind-probe (não é indeterminado, é fail-closed correto SÓ se NENHUM
// endereço responder). \`health()\` agora testa as DUAS famílias de loopback,
// na ordem — \`127.0.0.1\` primeiro (mantém o caminho comum exatamente tão
// rápido quanto antes: só tenta \`::1\` se o primeiro falhar de verdade).
const LOOPBACK_HOSTS = [HOST, '::1']
function healthOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume(); resolve((res.statusCode || 0) > 0)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
async function health(port, timeoutMs = 1500) {
  for (const host of LOOPBACK_HOSTS) {
    if (await healthOnce(host, port, timeoutMs)) return true
  }
  return false
}

// ── Heartbeat co-localizado (teste-v3-17) — ver comentário do gerador acima.
// Escrito só por um processo que nasceu no MESMO comando que confirmou o
// preview saudável pela 1ª vez (mesmo namespace de rede, garantido). Um
// comando FUTURO (status/ensure, em QUALQUER namespace) confia nisto antes
// de tentar seu PRÓPRIO probe HTTP — que pode estar isolado da porta real.
//
// VINCULADO À INSTÂNCIA (teste-v3-17b — pid reuse/heartbeat fantasma): um
// heartbeat só por {healthy, checkedAt} não prova que descreve o processo
// que TEMOS rastreado agora — um pid pode ser reaproveitado pelo SO depois
// que o processo original morre, e um heartbeat "fresco" nesse instante
// mentiria. Por isso todo heartbeat carrega o pid E um instanceId (token
// aleatório gerado quando a instância sobe) da instância que o escreveu;
// só é aceito se AMBOS baterem com o que está registrado AGORA em
// .supremo/preview.pid e .supremo/preview.instance — nunca só o pid
// sozinho. restart/stop invalidam (removem) o heartbeat e o token da
// instância ANTERIOR antes de qualquer coisa nova subir, então um heartbeat
// órfão nunca sobrevive além da instância que o gerou.
const HEARTBEAT_INTERVAL_MS = Number(process.env.SUPREMO_PREVIEW_HEARTBEAT_INTERVAL_MS) || 1000
const HEALTH_STALE_MS = Number(process.env.SUPREMO_PREVIEW_HEALTH_STALE_MS) || 5000

function currentInstanceId() {
  try {
    return readFileSync(INSTANCEFILE, 'utf8').trim() || null
  } catch {
    return null
  }
}
// Escrita ATÔMICA (tmp + rename, nunca truncate-then-write direto no
// arquivo final): status()/ensure() de outro processo podem ler HEALTH_FILE
// a qualquer momento, inclusive NO MEIO de uma escrita — sem isto, uma
// leitura concorrente podia pegar um JSON truncado/vazio. rename() é
// atômico no mesmo filesystem (mesma pasta) em POSIX: quem lê sempre vê o
// conteúdo INTEIRO de uma escrita ou o INTEIRO da anterior, nunca uma
// mistura.
function writeHealthState(ok, pid, instanceId) {
  try {
    const data = JSON.stringify({ healthy: ok, checkedAt: Date.now(), pid, instanceId })
    const tmp = \`\${HEALTH_FILE}.\${process.pid}.tmp\`
    writeFileSync(tmp, data)
    renameSync(tmp, HEALTH_FILE)
  } catch {
    /* best-effort — nunca trava o heartbeat por um erro de escrita */
  }
}
// Mesma regra pura de harness.isHeartbeatFresh (mantidas em sincronia).
function heartbeatFresh(checkedAt, nowMs, staleMs) {
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return false
  const age = nowMs - checkedAt
  return age >= 0 && age <= staleMs
}
// Mesma regra pura de harness.isHeartbeatTrusted (mantidas em sincronia).
// pid é o pid ATUALMENTE rastreado (readPid()) — o heartbeat só conta se
// descrever ESSA instância, viva, com o token batendo.
function readHeartbeatHealthy(pid) {
  try {
    const raw = JSON.parse(readFileSync(HEALTH_FILE, 'utf8'))
    if (raw.healthy !== true) return false
    if (!heartbeatFresh(raw.checkedAt, Date.now(), HEALTH_STALE_MS)) return false
    if (raw.pid !== pid) return false
    const instance = currentInstanceId()
    if (!instance || raw.instanceId !== instance) return false
    if (!alive(pid)) return false
    return true
  } catch {
    return false
  }
}
// "Saudável" combinado: heartbeat PRIMEIRO (leitura de arquivo, quase
// instantânea, e é o sinal CORRETO quando este comando está isolado do
// namespace real — ver comentário do gerador) — só cai pro probe HTTP
// direto (o caminho de sempre) se o heartbeat estiver ausente, velho
// demais, ou não descrever mais a instância atual (pid/token).
async function healthCombined(pid, port) {
  if (readHeartbeatHealthy(pid)) return true
  return health(port)
}
// Sobe o heartbeat DESACOPLADO (mesmo padrão de startDetached) — nasce no
// MESMO comando que acabou de confirmar a candidata saudável via
// waitReady(), então seu probe HTTP nunca sofre o isolamento de rede
// por-comando: está no namespace CERTO, para sempre, enquanto o pid
// rastreado seguir vivo.
function startHeartbeatWriter(pid, port, instanceId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, '__heartbeat', String(pid), String(port), instanceId], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}
async function heartbeatLoop(pid, port, instanceId) {
  // Para de escrever assim que deixarmos de ser a instância REGISTRADA
  // (alguém nos substituiu — restart/stop) — nunca continua sondando/
  // escrevendo por cima do heartbeat de uma instância NOVA só porque nosso
  // próprio processo ainda está no meio de terminar.
  while (alive(pid) && currentInstanceId() === instanceId) {
    writeHealthState(await health(port), pid, instanceId)
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS))
  }
  // Só limpa o HEALTH_FILE se AINDA formos a instância atual (morremos
  // "naturalmente", ninguém nos substituiu ainda) — se já fomos
  // substituídos, o arquivo já foi invalidado/reescrito por quem assumiu, e
  // apagá-lo aqui poderia derrubar o heartbeat da instância NOVA por engano.
  if (currentInstanceId() === instanceId) {
    try { rmSync(HEALTH_FILE, { force: true }) } catch {}
  }
}

// Orçamento de espera por readiness — configurável só por env (default
// inalterado: 90 tentativas de 1s = até 90s); existe pra testes de
// regressão simularem uma candidata que nunca fica saudável sem esperar
// minutos, sem mudar o comportamento padrão em produção.
const WAIT_TRIES = Number(process.env.SUPREMO_PREVIEW_WAIT_TRIES) || 90
const WAIT_INTERVAL_MS = Number(process.env.SUPREMO_PREVIEW_WAIT_INTERVAL_MS) || 1000
async function waitReady(port, tries = WAIT_TRIES) {
  for (let i = 0; i < tries; i++) { if (await health(port)) return true; await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS)) }
  return false
}
// Mesma decisão pura de harness.decidePreviewAction (mantidas em sincronia).
function decide(pidAlive, healthy) {
  if (pidAlive && healthy) return 'reuse'
  if (pidAlive && !healthy) return 'restart'
  return 'start'
}
function startDetached(port) {
  mkdirSync(DIR, { recursive: true })
  const out = openSync(LOG, 'a')
  // DESACOPLADO do pai: sobrevive ao fim do turno/comando do agente.
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  })
  child.unref()
  // NÃO grava PIDFILE/PORTFILE aqui — só depois que ensure() confirmar via
  // waitReady que a candidata ficou saudável (ver ensure()). Escrever cedo
  // demais foi exatamente o bug real do E2E: uma candidata que morre (ex.:
  // listen EPERM num sandbox) sobrescrevia o rastro de uma instância
  // anterior que seguia viva e saudável em outra porta.
  return child.pid
}
async function ensure() {
  const pid = readPid()
  const trackedPort = readPort() ?? PORT
  // Nunca descarta uma instância rastreada só por não sinalizar o pid via
  // kill(pid,0) — EPERM (comum em sandboxes como o do Codex, onde o mesmo
  // pid pode existir e estar saudável num contexto isolado, sem ser
  // sinalizável a partir deste) NÃO prova que morreu (ver pidState/alive).
  // A prova de verdade é responder saudável na PRÓPRIA porta persistida —
  // checada aqui, SEMPRE, antes de cogitar subir qualquer coisa nova.
  // healthCombined() (teste-v3-17): confia no heartbeat co-localizado antes
  // de um probe HTTP que pode estar isolado do namespace real — sem isso,
  // um comando isolado concluiria "não respondeu" e mataria/substituiria
  // uma instância saudável de verdade só por não conseguir alcançá-la.
  const action = decide(alive(pid), await healthCombined(pid, trackedPort))
  if (action === 'reuse') {
    console.log(\`✓ preview já no ar (pid \${pid}, http://localhost:\${trackedPort})\`)
    return
  }
  if (action === 'restart') {
    // Zumbi: mata o que tínhamos rastreado (inofensivo mesmo se não der pra
    // sinalizar — EPERM/ESRCH aqui são só engolidos). NÃO apaga
    // .supremo/preview.pid|.port ainda — só depois que a candidata nova
    // passar no healthcheck: nunca sobrescreve estado válido antes disso.
    try { process.kill(pid) } catch {}
    // Invalida o heartbeat/token da instância ANTERIOR JÁ, e não só quando
    // a candidata nova ficar pronta (teste-v3-17b): entre agora e a
    // candidata nova responder saudável, ninguém deve confiar num
    // heartbeat que ainda descreve o processo que acabamos de matar.
    rmSync(HEALTH_FILE, { force: true })
    rmSync(INSTANCEFILE, { force: true })
  }
  // Nenhuma instância rastreada respondeu saudável: escolhe porta (NUNCA
  // assume que a preferida está livre sem confirmar — bind-probe IPv4+IPv6,
  // ver isPortFree) e sobe uma candidata nova.
  const chosen = await pickPort(PORT)
  if (chosen === null) {
    console.error(\`✗ portas \${PORT}-\${PORT + PORT_SEARCH_SPAN - 1} todas ocupadas — não consigo subir o preview. Libere uma porta ou rode com PORT=<outra>.\`)
    process.exitCode = 1
    return
  }
  if (chosen !== PORT) {
    console.log(\`• porta \${PORT} ocupada por outro processo — usando \${chosen}\`)
  }
  const newPid = startDetached(chosen)
  const ok = await waitReady(chosen)
  if (!ok) {
    // Candidata NÃO ficou saudável (ex.: listen EPERM num sandbox, como no
    // E2E real) — NUNCA sobrescreve .supremo/preview.pid|.port: um estado
    // anterior válido (mesmo que não confirmado saudável agora) continua
    // intacto em vez de virar um pid/porta mortos. Mata a tentativa que não
    // decolou, pra não deixar processo órfão.
    try { process.kill(newPid) } catch {}
    console.log(\`• preview não respondeu em http://localhost:\${chosen} (pid \${newPid}) — mantendo estado anterior; veja .supremo/preview.log\`)
    return
  }
  writeFileSync(PIDFILE, String(newPid))
  writeFileSync(PORTFILE, String(chosen))
  // Token da instância ATUAL (teste-v3-17b) — gerado agora, junto com o
  // pid/porta desta candidata; é o que amarra o heartbeat a ELA
  // especificamente, nunca a um pid velho reaproveitado pelo SO.
  const instanceId = randomUUID()
  writeFileSync(INSTANCEFILE, instanceId)
  // waitReady() acima JÁ confirmou saudável NESTE MESMO comando/namespace —
  // grava o heartbeat na hora (nunca deixa a 1ª leitura futura sem nada) e
  // sobe o escritor que vai mantê-lo fresco enquanto o processo viver.
  writeHealthState(true, newPid, instanceId)
  startHeartbeatWriter(newPid, chosen, instanceId)
  console.log(\`✓ preview no ar (pid \${newPid}, http://localhost:\${chosen})\`)
}
async function status() {
  const pid = readPid()
  const port = readPort() ?? PORT
  const up = alive(pid)
  console.log(JSON.stringify({ running: up, healthy: up && (await healthCombined(pid, port)), pid: pid ?? null, port, url: \`http://localhost:\${port}\` }))
}
function stop() {
  const pid = readPid()
  if (alive(pid)) { try { process.kill(pid) } catch {} }
  rmSync(PIDFILE, { force: true })
  rmSync(PORTFILE, { force: true })
  rmSync(HEALTH_FILE, { force: true })
  rmSync(INSTANCEFILE, { force: true })
  console.log('✓ preview parado')
}
const cmd = process.argv[2] || 'ensure'
if (cmd === 'ensure') await ensure()
else if (cmd === 'status') await status()
else if (cmd === '__heartbeat') await heartbeatLoop(Number(process.argv[3]), Number(process.argv[4]), process.argv[5])
else if (cmd === 'stop') stop()
else { console.error('uso: node scripts/preview.mjs ensure|status|stop'); process.exit(1) }
void existsSync
`
}

/** O `scripts/verify.mjs` — classificador embutido a partir das regras do Supremo. */
export function verifyScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo — verify adaptativo. NÃO edite as regras à mão: elas vêm
// do classificador do Supremo (fonte única). Uso:
//   node scripts/verify.mjs            → auto (git diff working+staged)
//   node scripts/verify.mjs --staged   → auto, só staged (usado no pre-commit)
//   node scripts/verify.mjs quick|security|full → força o nível
import { exec, execSync } from 'node:child_process'
import { promisify } from 'node:util'
const execAsync = promisify(exec)
import { readFileSync } from 'node:fs'

const FULL_PATTERNS = ${serializePatterns(FULL_PATTERNS)}
const SECURITY_PATTERNS = ${serializePatterns(SECURITY_PATTERNS)}
const QUICK_PATTERNS = ${serializePatterns(QUICK_PATTERNS)}
const BROAD_FILE_COUNT = ${BROAD_FILE_COUNT}
// Só o passo \`build\` consulta isto — ver ENV_BUILD_FAILURE_PATTERNS em
// verify-classifier.ts (fonte única, mesma regra testada lá).
const ENV_BUILD_FAILURE_PATTERNS = ${serializePatterns(ENV_BUILD_FAILURE_PATTERNS)}
const isKnownEnvironmentalBuildFailure = (output) => ENV_BUILD_FAILURE_PATTERNS.some((re) => re.test(output))

// Ruído CONHECIDO/transitório do Next em tsconfig.json (v3-11) — MESMA
// detecção estrutural de isKnownNextTsconfigNoise em verify-classifier.ts
// (idêntica à usada pelo restore em packages/cli/src/restore.ts, E2E v3-10)
// — nunca uma heurística textual nova. Só JSON-diff estrito: qualquer coisa
// fora do padrão exato (inclusive JSON inválido) fica fail-closed (false).
const NEXT_TSCONFIG_TYPES_GLOB_RE = ${serializePatterns([NEXT_TSCONFIG_TYPES_GLOB_RE])}[0]
function deepEqualJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqualJson(v, b[i]))
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqualJson(a[k], b[k]))
  }
  return false
}
function isKnownNextTsconfigNoise(before, after) {
  let a, b
  try {
    a = JSON.parse(before)
    b = JSON.parse(after)
  } catch {
    return false
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return false
  const { include: includeA, ...restA } = a
  const { include: includeB, ...restB } = b
  if (!Array.isArray(includeA) || !Array.isArray(includeB)) return false
  if (!includeA.every((x) => typeof x === 'string') || !includeB.every((x) => typeof x === 'string')) return false
  if (!deepEqualJson(restA, restB)) return false
  const setA = new Set(includeA)
  const setB = new Set(includeB)
  const added = includeB.filter((x) => !setA.has(x))
  const removed = includeA.filter((x) => !setB.has(x))
  if (added.length === 0 && removed.length === 0) return false
  return [...added, ...removed].every((entry) => NEXT_TSCONFIG_TYPES_GLOB_RE.test(entry))
}
// Só tsconfig.json (nome exato, raiz) é elegível — mesma restrição do
// restore. Compara HEAD (último checkpoint) × worktree ATUAL: se a diferença
// inteira bate na assinatura do Next, é ruído — mesmo já estando dirty antes
// deste prompt (é exatamente esse o caso real, teste-v3-11).
function knownNoisePaths(paths) {
  if (!paths.includes('tsconfig.json')) return []
  let before
  try {
    before = execSync('git show HEAD:tsconfig.json', { encoding: 'utf8' })
  } catch {
    return []
  }
  let after
  try {
    after = readFileSync('tsconfig.json', 'utf8')
  } catch {
    return []
  }
  return isKnownNextTsconfigNoise(before, after) ? ['tsconfig.json'] : []
}

function changedFiles(stagedOnly) {
  try {
    const cmds = stagedOnly
      ? ['git diff --cached --name-only']
      : ['git diff --name-only HEAD', 'git diff --cached --name-only']
    const set = new Set()
    for (const c of cmds) {
      for (const line of execSync(c, { encoding: 'utf8' }).split('\\n')) {
        const p = line.trim()
        if (p) set.add(p)
      }
    }
    return [...set]
  } catch {
    return []
  }
}

const anyMatch = (p, pats) => pats.some((re) => re.test(p))

function classify(paths, noisePaths) {
  if (paths.length === 0) return { level: 'quick', reason: 'Nada alterado.' }
  const noiseSet = new Set(noisePaths ?? [])
  const riskPaths = paths.filter((p) => !noiseSet.has(p))
  const noiseSuffix = noiseSet.size > 0 ? ' (tsconfig.json: ruído conhecido do Next, ignorado)' : ''
  const full = riskPaths.some((p) => anyMatch(p, FULL_PATTERNS))
  const security = riskPaths.some((p) => anyMatch(p, SECURITY_PATTERNS))
  const cosmetic = paths.every((p) => noiseSet.has(p) || anyMatch(p, QUICK_PATTERNS))
  if (full || riskPaths.length > BROAD_FILE_COUNT)
    return {
      level: 'full',
      reason: (full ? 'Arquitetura/build/config.' : \`Mudança ampla (\${riskPaths.length}).\`) + noiseSuffix,
    }
  if (security) return { level: 'security', reason: 'Área sensível à segurança.' + noiseSuffix }
  if (cosmetic) return { level: 'quick', reason: 'Só cosmético.' + noiseSuffix }
  return { level: 'quick', reason: 'Alteração de baixo risco.' + noiseSuffix }
}

// Os testes de RLS (*.rls.test.ts) exigem um Postgres real (service_role +
// supabase local). Num bootstrap fresco isso não existe (por design: só env
// pública chega). Então excluímos RLS do vitest padrão e só rodamos os testes
// de RLS quando há Supabase local; senão, o gate "Políticas RLS" do CI cobre.
const hasLocalDb = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
const UNIT = 'vitest run --exclude "**/*.rls.test.ts"'
const rlsStep = hasLocalDb ? [['rls / isolamento', 'vitest run rls.test']] : []

const STEPS = {
  quick: [
    ['typecheck', 'tsc --noEmit'],
    ['lint', 'eslint'],
    ['testes afetados', 'vitest run --changed HEAD --passWithNoTests --exclude "**/*.rls.test.ts"'],
    ['secret scan', 'node scripts/security-audit.js --staged --strict'],
  ],
  security: [
    ['typecheck', 'tsc --noEmit'],
    ['lint', 'eslint'],
    ['unit + integração', UNIT],
    ...rlsStep,
    ['secret scan', 'node scripts/security-audit.js --strict'],
  ],
  full: [
    ['typecheck', 'tsc --noEmit'],
    ['lint', 'eslint'],
    ['unit + integração', UNIT],
    ...rlsStep,
    ['secret scan', 'node scripts/security-audit.js --strict'],
    ['build', 'next build'],
  ],
}

const args = process.argv.slice(2)
const stagedOnly = args.includes('--staged')
const forced = args.find((a) => ['quick', 'security', 'full'].includes(a))
const paths = changedFiles(stagedOnly)
const { level, reason } = forced
  ? { level: forced, reason: 'Nível forçado.' }
  : classify(paths, knownNoisePaths(paths))

console.log(\`\\n▸ verify [\${level.toUpperCase()}] — \${reason} (\${paths.length} arquivo(s))\\n\`)
const t0 = Date.now()
let buildDeferred = false
// Verificações independentes em paralelo; build só começa após todas passarem.
const checks = STEPS[level].filter(([label]) => label !== 'build')
const results = await Promise.allSettled(checks.map(async ([label, cmd]) => {
  const started = Date.now()
  await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 })
  return { label, seconds: ((Date.now() - started) / 1000).toFixed(1) }
}))
for (let index = 0; index < results.length; index++) {
  const result = results[index]
  const [label] = checks[index]
  if (result.status === 'rejected') {
    const err = result.reason
    if (err.stdout) process.stderr.write(err.stdout.toString())
    if (err.stderr) process.stderr.write(err.stderr.toString())
    console.error(\`\\n✗ verify \${level} falhou em: \${label}\\n\`)
  } else console.log(\`  • \${label}… ok (\${result.value.seconds}s)\`)
}
if (results.some((result) => result.status === 'rejected')) process.exit(1)
for (const [label, cmd] of STEPS[level].filter(([label]) => label === 'build')) {
  process.stdout.write(\`  • \${label}… \`)
  try {
    execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('ok')
  } catch (err) {
    const output = \`\${err.stdout ?? ''}\${err.stderr ?? ''}\`.toString()
    // SÓ o build pode ser deferido, e SÓ com uma assinatura CONHECIDA de
    // limitação ambiental (porta/processo do sandbox, rede indisponível pra
    // recurso externo). typecheck/lint/testes/secret scan NUNCA entram aqui
    // — bloqueiam sempre. Na dúvida (assinatura não bate), cai no fail-closed
    // de baixo: falha normal, checkpoint NÃO prossegue.
    if (label === 'build' && isKnownEnvironmentalBuildFailure(output)) {
      console.log('DEFERIDO (limitação ambiental do sandbox)')
      console.log('  ℹ build falhou por limitação ambiental conhecida (porta/processo ocupado ou rede indisponível pra recurso externo) — não é erro de código. Deferido para a CI obrigatória (fail-closed lá); checkpoint local pode prosseguir.')
      buildDeferred = true
      continue
    }
    console.log('FALHOU')
    if (err.stdout) process.stderr.write(err.stdout.toString())
    if (err.stderr) process.stderr.write(err.stderr.toString())
    console.error(\`\\n✗ verify \${level} falhou em: \${label}\\n\`)
    process.exit(1)
  }
}
if (!hasLocalDb && (level === 'security' || level === 'full')) {
  console.log('  ℹ RLS pulado (sem Supabase local) — validado no gate "Políticas RLS" do CI. Para rodar local: npm run local:start && npm run test:rls')
}
const deferredSuffix = buildDeferred ? ' — build DEFERIDO para a CI (limitação ambiental do sandbox; CI é fail-closed antes do merge)' : ''
console.log(\`\\n✓ verify \${level} passou em \${((Date.now() - t0) / 1000).toFixed(1)}s\${deferredSuffix}\\n\`)
`
}

/** O `scripts/setup-local.mjs` — idempotente, prepara a máquina pós-clone. */
export function setupLocalScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo — setup local idempotente. Rodar de novo não destrói nada.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const step = (label, fn) => {
  process.stdout.write(\`  • \${label}… \`)
  try { fn(); console.log('ok') }
  catch (e) { console.log('FALHOU'); console.error(String(e?.message ?? e)); process.exit(1) }
}

console.log('\\nSupremo — setup local\\n')

step('runtime Node', () => {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) throw new Error(\`Node \${process.versions.node} < 18\`)
})

step('.env.local', () => {
  if (!existsSync('.env.local')) {
    throw new Error('.env.local ausente — rode o bootstrap do Supremo primeiro.')
  }
})

step('dependências', () => {
  if (!existsSync('node_modules')) execSync('npm ci', { stdio: 'inherit' })
})

step('git hooks', () => {
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' })
})

step('baseline (verify quick)', () => {
  execSync('node scripts/verify.mjs quick', { stdio: 'inherit' })
})

console.log('\\n✓ pronto. Preview persistente: npm run preview:ensure\\n')
`
}

const preCommitHook = `#!/bin/sh
# GERADO pelo Supremo — validação rápida/adaptativa do que está staged.
exec node scripts/verify.mjs --staged
`

const prePushHook = `#!/bin/sh
# GERADO pelo Supremo (v3) — defesa local em profundidade.
#
# 1) NUNCA empurrar direto para a main. A integração na main é do GitHub/Supremo
#    (assíncrona), só com os required checks do HEAD atual verdes. No GitHub Free
#    privado, sem branch protection nativa, este hook é a barreira local que impede
#    o push direto. Trabalhe sempre numa branch de desenvolvimento.
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master)
      echo "✗ Push direto para a main bloqueado. Trabalhe numa branch de desenvolvimento;" >&2
      echo "  a main é integrada pelos gates (auto-merge), nunca por push direto." >&2
      exit 1
      ;;
  esac
done
# 2) validação adaptativa antes do push; o GitHub CI é a barreira independente final.
exec node scripts/verify.mjs
`

/**
 * Todos os arquivos do harness (relativos à raiz do projeto gerado). O conjunto
 * base é capability-agnóstico: o verify decide o nível pelo git diff em runtime,
 * então não precisa ser parametrizado por capability aqui.
 */
/**
 * Diagnóstico agregado (v3.1 finalização, seção 29) — junta o status do preview
 * e do checkpoint daemon num JSON só. NÃO é para o dev comum rodar no dia a dia
 * (a UI do Supremo/Histórico é o lugar humano); serve para depuração rápida.
 * Best-effort: se um dos dois não responder, o outro ainda aparece.
 *
 * `--ensure` (preflight local de retomada — v3.4, ex-"retomada automática de
 * sessão" v3.2/seção 30): mesmo script, modo opcional. Depois do bootstrap já
 * ter rodado uma vez NESTA máquina, o usuário nunca deveria precisar rodar
 * bootstrap de novo — só reabrir a pasta e mandar um pedido. `--ensure` é
 * ISSO: religa o que morreu (reboot, agente fechado) chamando os MESMOS
 * mecanismos que o bootstrap já usa (`preview:ensure`/o supervisor do daemon
 * — cada um já distingue vivo+saudável de zumbi/morto sozinho, sem lógica
 * nova aqui), reusa o que já está de pé, e nunca builda/testa/reinstala/
 * relinca/reautentica. Sempre termina imprimindo o status FINAL (inclusive a
 * URL real do preview) — não o snapshot de antes de religar.
 *
 * E2E real (teste-v3-12) — por que a checagem do DAEMON não pode passar por
 * npx no caminho saudável: a versão anterior lia `daemon --status` via
 * `npx --yes supremo-cli ...`; sem versão pinada, o npx confere a versão mais
 * recente no registry TODA vez, mesmo com o pacote em cache — uma chamada de
 * rede. Isso era tolerável rodando uma vez por sessão; deixa de ser MÍNIMO
 * quando `--ensure` passa a rodar antes de TODO pedido (a correção deste
 * ajuste — a antiga regra de "só no primeiro pedido da sessão" não é
 * confiável: o host pode restaurar a MESMA conversa depois de fechar/reabrir
 * o agente sem nenhum sinal de que o processo reiniciou, e é exatamente
 * nesse reinício que preview/daemon podem ter morrido). A leitura do daemon
 * abaixo é 100% LOCAL — mesma classificação de `process.kill(pid, 0)` já
 * usada no supervisor de preview (`classifyPidSignalError` aqui) e no daemon
 * real (`packages/cli/src/daemon.ts#classifyPidSignalError`, mesmo
 * comentário lá — os pacotes não compartilham módulo, então o padrão se
 * repete de propósito, nunca uma heurística nova).
 *
 * E2E real (teste-v3-15) — por que RELIGAR o daemon também não pode passar
 * por `npx`: no Terminal (rede plena de um humano), `npx --yes supremo-cli
 * daemon --ensure` resolve o pacote em segundos; rodado pelo AGENTE (rede
 * restrita/proxy do sandbox), a MESMA chamada podia ficar presa no
 * retry/backoff interno do próprio npm por ~1m30 antes de desistir — e só
 * ENTÃO o preflight chegava no preview. `--ensure` agora resolve
 * `node_modules/.bin/supremo` DIRETO (mesmo padrão já usado pra CLI do
 * Supabase — `packages/cli/src/bootstrap.ts#resolveSupabaseBin`, `supremo-cli`
 * PINADA como devDependency do scaffold): `npx` NUNCA é tocado, nem no
 * caminho saudável nem ao religar. Ausente/corrompido → nunca cai pra
 * `npx`/global nem tenta `npm install` sozinho (seria bootstrap automático,
 * fora do preflight) — fica não-saudável com uma mensagem clara, fail-closed.
 */
export function supremoStatusScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo (v3.1/v3.4) — diagnóstico agregado (preview + daemon).
// Uso:
//   node scripts/supremo-status.mjs           → só diagnostica (read-only)
//   node scripts/supremo-status.mjs --ensure  → religa o que morreu, depois
//                                                imprime o status FINAL
// Não é para uso diário do humano — a UI do Supremo (Histórico) é o lugar
// humano; isto é o PREFLIGHT LOCAL do agente, rodado antes de todo pedido
// que muda código (v3.4) — por isso o daemon é 100% local: status lê o pid
// direto, e religar (--ensure) resolve node_modules/.bin/supremo direto —
// nunca passa por npx, nem no caminho saudável nem ao religar (v3.4.4,
// teste-v3-15; ver comentário acima).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

function tryJson(cmd, args) {
  try {
    return JSON.parse(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

// Best-effort: nunca lança. Se o ensure falhar (ex.: sem porta livre), o
// status final abaixo reflete a falha real — não fingimos sucesso.
// \`timeoutMs\` é opcional (undefined = sem teto, como sempre foi) — usado só
// na chamada do daemon abaixo (teste-v3-15); nunca é um AUMENTO de timeout,
// é o primeiro teto onde antes não existia nenhum.
function run(cmd, args, timeoutMs) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], ...(timeoutMs ? { timeout: timeoutMs } : {}) })
  } catch {
    /* best-effort — ver comentário acima */
  }
}

// ── Daemon: leitura LOCAL direta do pidfile (nunca via npx — ver comentário
// no gerador). Mesma classificação de process.kill(pid, 0) do supervisor de
// preview e do daemon real (packages/cli/src/daemon.ts#classifyPidSignalError).
const DAEMON_PID_FILE = '.supremo/checkpoints/daemon.pid'
const QUEUE_FILE = '.supremo/checkpoints/queue.jsonl'
const RETRIABLE = new Set(['local', 'upload_pending', 'publishing'])

function classifyPidSignalError(code) {
  return code === 'ESRCH' ? 'dead' : 'unknown'
}

function daemonPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return classifyPidSignalError(err && err.code) !== 'dead'
  }
}

function readDaemonLocal() {
  let pid = null
  try {
    const raw = Number(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim())
    if (Number.isFinite(raw) && raw > 0) pid = raw
  } catch {
    /* sem pidfile — daemon nunca rodou nesta máquina */
  }
  const running = pid !== null && daemonPidAlive(pid)
  let pendingCheckpoints = 0
  try {
    for (const line of fs.readFileSync(QUEUE_FILE, 'utf8').split('\\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec = JSON.parse(t)
        if (RETRIABLE.has(rec.pushStatus)) pendingCheckpoints += 1
      } catch {
        /* linha corrompida — ignora, mesma tolerância de parseQueue */
      }
    }
  } catch {
    /* sem fila ainda: 0 pendências */
  }
  return { running, healthy: running, pendingCheckpoints }
}

const readPreview = () => tryJson('node', ['scripts/preview.mjs', 'status']) ?? { running: false, healthy: false }
const readDaemon = readDaemonLocal

// ── Religar o daemon é 100% LOCAL (teste-v3-15) — supremo-cli é uma
// devDependency PINADA do scaffold (mesmo padrão de resolveSupabaseBin em
// packages/cli/src/bootstrap.ts): node_modules/.bin/supremo existe depois de
// um npm install/ci comum, e é isso que \`--ensure\` roda direto. NUNCA npx,
// NUNCA o registry, NUNCA um fallback pra instalação global (que voltaria a
// depender de rede) — ausente/corrompido é fail-closed com mensagem clara,
// não um \`npm install\` automático (isso seria bootstrap, fora do preflight).
const LOCAL_SUPREMO_CLI_BIN = 'node_modules/.bin/supremo'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// E2E real (teste-v3-14): logo depois de \`ensure\` subir/religar o preview, o
// processo já está \`running=true\`, mas o Next ainda pode estar compilando a
// 1ª rota — \`healthy=false\` por alguns segundos, sem nada estar de fato
// quebrado. Uma ÚNICA leitura de \`preview.mjs status\` logo em seguida (o que
// o preflight fazia antes) é uma corrida, não uma prova de falha: o mesmo
// comando, rodado poucos segundos depois sem nenhuma intervenção, já
// mostrava \`healthy=true\`. Por isso, depois de CADA \`ensure\`, o preflight dá
// ao preview uma janela CURTA e LIMITADA pra ficar saudável — polling local
// leve (só relê o pidfile/porta e faz um GET em localhost, nunca rede
// externa), nunca um loop sem fim: para assim que \`healthy\` vira true, ou no
// mais tardar quando a janela esgota.
const PREVIEW_POLL_INTERVAL_MS = Number(process.env.SUPREMO_PREFLIGHT_POLL_INTERVAL_MS) || 300
const PREVIEW_POLL_TIMEOUT_MS = Number(process.env.SUPREMO_PREFLIGHT_POLL_TIMEOUT_MS) || 4000

async function waitForPreviewHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state = readPreview()
  while (!state.healthy && Date.now() < deadline) {
    await sleep(PREVIEW_POLL_INTERVAL_MS)
    state = readPreview()
  }
  return state
}

let preview = readPreview()
let daemon = readDaemon()
let daemonEnsureError = null

// E2E real (teste-v3-15) — histórico: no Terminal (rede plena de um
// humano), \`npx --yes supremo-cli daemon --ensure\` resolvia o pacote e
// religava o daemon em segundos; rodado pelo AGENTE (rede restrita/proxy do
// sandbox), a MESMA chamada podia ficar presa no retry/backoff interno do
// próprio npm por ~1m30 antes de desistir. A v3.4.3 deste preflight só
// pôs um teto curto nessa chamada de rede — reduzia a espera, mas não
// eliminava a dependência de rede em si. A v3.4.4 corrige isso pela raiz:
// \`supremo-cli\` é devDependency PINADA do scaffold (mesmo padrão de
// resolveSupabaseBin em packages/cli/src/bootstrap.ts) — \`--ensure\` religa
// via \`node_modules/.bin/supremo\` DIRETO (ver LOCAL_SUPREMO_CLI_BIN acima),
// nunca mais \`npx\`, nunca mais registry, em caminho NENHUM. O teto abaixo
// permanece (não interfere — uma invocação local não trava esperando rede)
// mas deixou de ser necessário: é só uma rede de segurança, não a correção.
const DAEMON_ENSURE_TIMEOUT_MS = Number(process.env.SUPREMO_DAEMON_ENSURE_TIMEOUT_MS) || 10_000

if (process.argv.includes('--ensure')) {
  // Cada \`ensure\` decide sozinho reusar (já saudável), religar (rastro
  // morto/zumbi) ou subir do zero (nada registrado) — a MESMA lógica do
  // bootstrap, nenhuma nova aqui. Só chama quando o status leu não-saudável;
  // e é só AQUI, com o daemon comprovadamente morto, que a CLI local roda —
  // sempre local, nunca rede (ver LOCAL_SUPREMO_CLI_BIN acima). Ausente/
  // corrompido → NUNCA cai pra npx/global nem tenta \`npm install\` sozinho
  // (seria bootstrap automático, fora do preflight) — fail-closed com
  // mensagem clara.
  if (!daemon.healthy) {
    if (fs.existsSync(LOCAL_SUPREMO_CLI_BIN)) {
      run(LOCAL_SUPREMO_CLI_BIN, ['daemon', '--ensure'], DAEMON_ENSURE_TIMEOUT_MS)
      daemon = readDaemon()
    } else {
      daemonEnsureError =
        'supremo-cli local ausente (node_modules/.bin/supremo) — rode "npm install" e tente de novo.'
    }
  }
  if (!preview.healthy) {
    run('node', ['scripts/preview.mjs', 'ensure'])
    preview = await waitForPreviewHealthy(PREVIEW_POLL_TIMEOUT_MS)

    // E2E real (teste-v3-13): a primeira tentativa do supervisor pode falhar
    // de verdade (ex.: corrida de porta, processo anterior que ainda não
    // soltou o bind) — sem retry, o preview ficava morto e o agente seguia
    // editando/fazendo checkpoint mesmo assim. UMA única recuperação extra,
    // pelo MESMO supervisor (nenhuma lógica nova, nunca um loop): só roda
    // quando a janela de espera acima esgotou e o preview REALMENTE não
    // ficou saudável — não por causa de uma leitura cedo demais.
    if (!preview.healthy) {
      run('node', ['scripts/preview.mjs', 'ensure'])
      preview = await waitForPreviewHealthy(PREVIEW_POLL_TIMEOUT_MS)
    }
  }
}

const healthy = preview.healthy && daemon.healthy

console.log(JSON.stringify({
  preview: { running: !!preview.running, healthy: !!preview.healthy, url: preview.url ?? null },
  daemon: {
    running: !!daemon.running,
    healthy: !!daemon.healthy,
    ...(daemonEnsureError ? { error: daemonEnsureError } : {}),
  },
  checkpoints: { pending: daemon.pendingCheckpoints ?? 0 },
}))

// O preflight (--ensure) só "termina" de verdade com os dois saudáveis — sai
// com código de erro pra nunca depender só do agente ter lido o JSON: se
// mesmo depois de religar (com o retry acima) preview ou daemon continuarem
// não-saudáveis, o comando falha de verdade (exit != 0), sinal pro agente
// parar e não editar/checkpoint (ver AGENTS.md/CLAUDE.md — teste-v3-13).
// No modo \`status\` (sem --ensure), só diagnostica — nunca falha por isso.
if (process.argv.includes('--ensure') && !healthy) {
  process.exitCode = 1
}
`
}

export function harnessFiles(): Record<string, string> {
  return {
    'scripts/verify.mjs': verifyScript(),
    'scripts/setup-local.mjs': setupLocalScript(),
    'scripts/preview.mjs': previewSupervisorScript(),
    'scripts/supremo-status.mjs': supremoStatusScript(),
    '.githooks/pre-commit': preCommitHook,
    '.githooks/pre-push': prePushHook,
  }
}
