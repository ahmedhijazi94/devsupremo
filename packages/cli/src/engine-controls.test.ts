import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { controlEngine } from './engine-controls'
import { readEnginePolicy } from './engine-policy'
import { readJson, writeJson } from './turn-workspace'

it('pauses/resumes repair independently of validation, preserving user options', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-controls-'))
  try {
    writeJson(path.join(root, '.supremo/project.json'), { projectId: '11111111-1111-4111-8111-111111111111' })
    writeJson(path.join(root, '.supremo/lifecycle.json'), { max_auto_repair_attempts: 3, auto_heal: { max_attempts: 1 } })
    await controlEngine(root, 'pause')
    expect(readEnginePolicy(root).auto_heal.paused).toBe(true)
    expect(readEnginePolicy(root).validation_mode).toBe('background_adaptive')
    await controlEngine(root, 'resume')
    expect(readEnginePolicy(root).auto_heal).toMatchObject({ paused: false, max_attempts: 1 })
    await controlEngine(root, 'on-request')
    expect(readEnginePolicy(root).validation_mode).toBe('on_request')
    await controlEngine(root, 'automatic')
    expect(readEnginePolicy(root).validation_mode).toBe('background_adaptive')
    expect(readJson(path.join(root, '.supremo/lifecycle.json'))).toMatchObject({ max_auto_repair_attempts: 3 })
    expect(await controlEngine(root, 'status')).toMatchObject({ budget: { monetaryCapUsd: null } })
    await expect(controlEngine(root, 'disable-security')).rejects.toThrow()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
