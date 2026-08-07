#!/usr/bin/env node
//
// The Node major version the action runs on is written down in several places,
// and they have to agree. In particular @types/node must not describe a newer
// runtime than the action actually runs on, or the compiler will happily accept
// APIs that are missing at runtime.
//
// Dependabot is told to hold @types/node at its current major
// (.github/dependabot.yml). That ignore follows whatever is in package.json, so
// raising the runtime is a deliberate edit of every file listed below - and
// this check is what makes forgetting one of them fail the build.

import { readFileSync } from 'node:fs'

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

/** Pulls the first integer out of a version-ish string. */
function major(value, file) {
  const match = String(value).match(/(\d+)/)
  if (!match) {
    throw new Error(`could not read a version out of ${file}: ${value}`)
  }
  return Number(match[1])
}

const pkg = JSON.parse(read('package.json'))
const actionYml = read('action.yml')
const dependabot = read('.github/dependabot.yml')

const usingMatch = actionYml.match(/using:\s*['"]?node(\d+)['"]?/)
if (!usingMatch) {
  console.error('action.yml has no `runs.using: nodeNN`')
  process.exit(1)
}

const sources = [
  {
    file: 'action.yml (runs.using)',
    value: `node${usingMatch[1]}`,
    major: Number(usingMatch[1])
  },
  {
    file: '.node-version',
    value: read('.node-version').trim(),
    major: major(read('.node-version'), '.node-version')
  },
  {
    file: 'package.json (engines.node)',
    value: pkg.engines.node,
    major: major(pkg.engines.node, 'engines.node')
  },
  {
    file: 'package.json (@types/node)',
    value: pkg.devDependencies['@types/node'],
    major: major(pkg.devDependencies['@types/node'], '@types/node')
  }
]

let failed = false

const width = Math.max(...sources.map((s) => s.file.length))
for (const source of sources) {
  console.log(`  ${source.file.padEnd(width)}  ${source.value}`)
}

const majors = [...new Set(sources.map((s) => s.major))]
if (majors.length > 1) {
  console.error(
    `\nNode major versions disagree: ${majors.sort((a, b) => a - b).join(' vs ')}.\n` +
      'All of the files above must name the same major. To move the action to a\n' +
      'new Node version, update every one of them together.'
  )
  failed = true
}

// The Dependabot guard must stay in place, otherwise @types/node quietly
// drifts past the runtime again.
const holdsTypesNode =
  /dependency-name:\s*['"]?@types\/node['"]?/.test(dependabot) &&
  /version-update:semver-major/.test(dependabot)
if (!holdsTypesNode) {
  console.error(
    '\n.github/dependabot.yml no longer holds @types/node at its current major.\n' +
      'Without that ignore, Dependabot will raise it past the runtime the action\n' +
      'declares in action.yml.'
  )
  failed = true
}

if (failed) {
  process.exit(1)
}

console.log(
  `\nNode ${majors[0]} declared consistently, and Dependabot holds @types/node there.`
)
