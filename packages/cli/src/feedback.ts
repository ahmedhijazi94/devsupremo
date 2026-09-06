import fs from 'node:fs'
import path from 'node:path'
import { feedbackEnvelopeSchema, type FeedbackEnvelope } from '../../../src/lib/checkpoint/feedback'

export const FEEDBACK_FILE = '.supremo/validation-feedback.json'
export interface FeedbackWorkerConfig {
  cwd: string
  projectId: string
  apiBaseUrl: string
  getSecret: () => string | null
}

/** Serial, bounded worker, independent from uploads/restores/database jobs. */
export async function refreshLocalFeedback(config: FeedbackWorkerConfig): Promise<boolean> {
  const file = path.join(config.cwd, FEEDBACK_FILE)
  let previous: FeedbackEnvelope | null = null
  try {
    previous = feedbackEnvelopeSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    if ([previous.current, previous.previousFailure].some((item) => item && item.projectId !== config.projectId)) previous = null
  } catch {
    // Missing or invalid cache is unknown, never a passing validation.
    previous = null
  }
  const secret = config.getSecret()
  if (!secret) return false
  try {
    const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, '')}/api/checkpoint/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecret: secret, projectId: config.projectId }),
      signal: AbortSignal.timeout(55_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const incoming = feedbackEnvelopeSchema.parse(await response.json())
    for (const snapshot of [incoming.current, incoming.previousFailure]) {
      if (snapshot && snapshot.projectId !== config.projectId) throw new Error('Projeto divergente')
    }
    if (previous?.current && incoming.current && previous.current.observedAt > incoming.current.observedAt) return false
    // The server preserves unresolved failures and knows about recoveries that
    // happened while this daemon was offline. Trust its validated envelope;
    // merging the old cache here would resurrect an already resolved failure.
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ ...incoming, receivedAt: new Date().toISOString() }), { mode: 0o600 })
    fs.renameSync(temp, file)
    return true
  } catch {
    // Preserve the last evidence and its original timestamp. Resume reports stale.
    console.error('[feedback] Diagnóstico indisponível; evidência anterior preservada. Nova tentativa em background.')
    return false
  }
}

export function startFeedbackWorker(config: FeedbackWorkerConfig): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const tick = async (): Promise<void> => {
    const ok = await refreshLocalFeedback(config)
    failures = ok ? 0 : failures + 1
    if (!stopped) timer = setTimeout(() => { void tick() }, Math.min(300_000, 60_000 * 2 ** Math.min(failures, 3)))
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
