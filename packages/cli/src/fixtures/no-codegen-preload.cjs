// Loaded before the executable: detect even probes whose EvalError is caught.
let attempts = 0
const original = globalThis.Function
globalThis.Function = new Proxy(original, {
  construct() {
    attempts++
    throw new Error('Dynamic code generation forbidden by CLI process test')
  },
  apply() {
    attempts++
    throw new Error('Dynamic code generation forbidden by CLI process test')
  },
})
process.on('exit', () => {
  if (attempts !== 0) {
    process.stderr.write(
      'CLI attempted dynamic code generation during startup or validation\n',
    )
    process.exitCode = 1
  }
})
