// One serialized rule for CLI validation and generated CI. Paths are canonical,
// project-relative source/test files, including Next scaffolds without src/.
const segment = String.raw`(?!\.{1,2}(?:/|$)|(?:node_modules|\.git|\.supremo)(?:/|$))[^/\\\x00-\x1f\x7f]+`
export const ACCEPTANCE_TEST_PATH_SOURCE = String.raw`^(?:(?:tests?|e2e|src|app|pages|lib|components|actions|hooks|features)/${segment}(?:/${segment})*\.(?:test|spec)\.[cm]?[jt]sx?|supabase/${segment}(?:/${segment})*\.rls\.test\.[cm]?[jt]sx?)$`
