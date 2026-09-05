import { writeFileSync } from 'node:fs'

// Vitest calls this only for the current run. A title, comment, skipped test
// or plain expect(true) does not supply the helper's completed proof metadata.
export default class IsolationReporter {
  onFinished(files, errors) {
    const passed = new Set()
    function visit(task) {
      if (task.type === 'test' && task.result?.state === 'pass'
        && typeof task.meta?.supremoIsolation === 'string') passed.add(task.meta.supremoIsolation)
      for (const child of task.tasks || []) visit(child)
    }
    for (const file of files || []) visit(file)
    writeFileSync(process.env.SUPREMO_ISOLATION_REPORT, JSON.stringify({ passed: [...passed], errors: errors?.length || 0 }))
  }
}
