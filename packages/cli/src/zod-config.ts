import { config } from 'zod'

// Run before any CLI schema is constructed. This is Zod's supported CSP mode:
// object validation uses its ordinary interpreter and never probes unsafe eval.
// Keep compile()/zod/compile out of the CLI; those are explicit codegen opt-ins.
config({ jitless: true })
