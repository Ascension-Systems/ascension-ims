#!/usr/bin/env node
/**
 * The generated disposition region in `docs/VERIFICATION.md`.
 *
 *   npm run verify:disposition            print the block
 *   npm run verify:disposition -- --write replace the region in docs/VERIFICATION.md in place
 *   npm run check:disposition             regenerate in memory; exit non-zero if the committed
 *                                         region differs
 *
 * This touches no database, needs no configuration and contacts nothing. It is the
 * manifest <-> document half of the anti-drift mechanism; `checkDrift` in both runners is the
 * code <-> manifest half.
 *
 * THE DOCUMENT IS NOT ALLOWED TO CARRY A HAND-WRITTEN COUNT OF ANYTHING THE CODE CAN COUNT.
 * That is the whole point: a prose figure has no mechanism keeping it true, and two people
 * counting the same document previously produced two different wrong answers.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST } from './lib/manifest.mjs'
import { REPO } from './hosted/lib/config.mjs'
import {
  computeDisposition,
  renderDocRegion,
  DISPOSITION_BEGIN,
  DISPOSITION_END,
  checkManifestIntegrity,
  checkDispositionSums,
  renderInvariantFailure,
} from './lib/disposition.mjs'

const DOC = join(REPO, 'docs', 'VERIFICATION.md')
const write = (s) => process.stdout.write(s)

function regionBounds(text) {
  const start = text.indexOf(DISPOSITION_BEGIN)
  const end = text.indexOf(DISPOSITION_END)
  if (start < 0 || end < 0 || end < start) return null
  return { start, end: end + DISPOSITION_END.length }
}

function main() {
  const args = process.argv.slice(2)

  /* ------------------------------------------------------------------ *
   * BEFORE ANYTHING ELSE. --write would otherwise happily generate a
   * block from a manifest carrying duplicate ids or an unknown state,
   * commit it to the document, and --check would then agree with it
   * forever. A generated figure is only as trustworthy as its source.
   * ------------------------------------------------------------------ */
  const totals = computeDisposition(MANIFEST)
  const integrity = checkManifestIntegrity(MANIFEST)
  const sums = checkDispositionSums(totals, MANIFEST)
  if (!integrity.ok || !sums.ok) {
    if (!integrity.ok) {
      write(renderInvariantFailure('MANIFEST INTEGRITY — the declared inventory is malformed.', integrity.problems))
    }
    if (!sums.ok) {
      write(renderInvariantFailure('DISPOSITION SUM INVARIANT — the printed figures do not reconcile.', sums.problems))
    }
    write('Nothing was generated, written or checked. Fix verify/lib/manifest.mjs and re-run.\n')
    process.exitCode = 1
    return
  }

  const region = renderDocRegion(totals)

  if (args.includes('--write')) {
    const text = readFileSync(DOC, 'utf8')
    const bounds = regionBounds(text)
    if (!bounds) {
      write(
        `docs/VERIFICATION.md has no DISPOSITION region. Add these two markers where the block ` +
          `belongs, then re-run:\n  ${DISPOSITION_BEGIN}\n  ${DISPOSITION_END}\n`,
      )
      process.exitCode = 1
      return
    }
    const next = text.slice(0, bounds.start) + region + text.slice(bounds.end)
    if (next === text) {
      write('docs/VERIFICATION.md is already up to date.\n')
      return
    }
    writeFileSync(DOC, next)
    write('docs/VERIFICATION.md: DISPOSITION region rewritten from verify/lib/manifest.mjs.\n')
    return
  }

  if (args.includes('--check')) {
    const text = readFileSync(DOC, 'utf8')
    const bounds = regionBounds(text)
    if (!bounds) {
      write(
        'FAIL: docs/VERIFICATION.md has no DISPOSITION region. The document is supposed to carry\n' +
          '      the generated block, and no count anywhere else. Run `npm run verify:disposition -- --write`.\n',
      )
      process.exitCode = 1
      return
    }
    const committed = text.slice(bounds.start, bounds.end)
    if (committed === region) {
      write('ok  : docs/VERIFICATION.md DISPOSITION region matches verify/lib/manifest.mjs.\n')
      return
    }
    write(
      'FAIL: the DISPOSITION region committed in docs/VERIFICATION.md does not match what\n' +
        '      verify/lib/manifest.mjs computes. The manifest is the authority. Run\n' +
        '      `npm run verify:disposition -- --write` and commit the result.\n\n' +
        '      --- committed ---\n' +
        committed
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n') +
        '\n\n      --- computed ---\n' +
        region
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n') +
        '\n',
    )
    process.exitCode = 1
    return
  }

  write(region + '\n')
}

main()
