/* eslint @typescript-eslint/no-require-imports: "off" -- The upstream Next ESLint plugin loads this entry point with require(). */
const { isAbsolute, parse } = require('node:path')
const { globSync: directoryGlobSync } = require('tinyglobby')

/**
 * The pinned @next/eslint-plugin-next calls only this API in get-root-dirs.
 * Fail if that contract changes instead of silently weakening root discovery.
 *
 * @param {unknown} pattern
 * @param {unknown} options
 * @returns {string[]}
 */
function globSync(pattern, options) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError('Next ESLint directory glob requires a nonempty string pattern')
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    Reflect.ownKeys(options).length !== 1 ||
    !Object.hasOwn(options, 'onlyDirectories') ||
    options.onlyDirectories !== true
  ) {
    throw new TypeError('Next ESLint directory glob supports only { onlyDirectories: true }')
  }

  // Picomatch cannot faithfully expand numeric, padded, or stepped ranges.
  // Explicit lists such as {web,admin} retain supported rootDir glob behavior.
  // Scan once: ambiguous repetitions in a regex can backtrack quadratically.
  let insideBrace = false
  let containsRange = false
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '{') {
      insideBrace = true
      containsRange = false
    } else if (character === '}') {
      if (insideBrace && containsRange) {
        throw new TypeError('Next ESLint rootDir brace ranges are unsupported; use an explicit brace list or rootDir array')
      }
      insideBrace = false
    } else if (insideBrace && character === '.' && pattern[index + 1] === '.') {
      containsRange = true
    }
  }

  return directoryGlobSync(pattern, {
    onlyDirectories: true,
    expandDirectories: false,
    absolute: isAbsolute(pattern),
  }).map((directory) => {
    // tinyglobby appends slashes to directories; fast-glob does not by default.
    if (directory.endsWith('/') && directory.length > parse(directory).root.length) {
      return directory.slice(0, -1)
    }
    return directory
  })
}

module.exports = { globSync }
