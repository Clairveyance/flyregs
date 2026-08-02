#!/usr/bin/env node
// Tier-gate audit: every gated surface x every tier, read straight from the
// source so it cannot drift from what the app actually does.
//
// The entitlement hierarchy is verified against RevenueCat (the premium
// products grant BOTH `pro` and `premium`; Plus is the separate one-time
// `unlocked` entitlement), so:
//     free    isUnlocked F  isPro F  isPremium F   hasPlusAccess F
//     plus    isUnlocked T  isPro F  isPremium F   hasPlusAccess T
//     pro     isUnlocked T  isPro T  isPremium F   hasPlusAccess T
//     premium isUnlocked T  isPro T  isPremium T   hasPlusAccess T
// (hasPlusAccess = isUnlocked || isPro || isPremium — src/context/auth.tsx)
import { readFileSync, readFileSync as _read } from 'fs'

const TIERS = {
  free:    { isUnlocked: false, isPro: false, isPremium: false },
  plus:    { isUnlocked: true,  isPro: false, isPremium: false },
  pro:     { isUnlocked: true,  isPro: true,  isPremium: false },
  premium: { isUnlocked: true,  isPro: true,  isPremium: true  },
}
const has = (t) => TIERS[t].isUnlocked || TIERS[t].isPro || TIERS[t].isPremium

// feature -> [file, gate flag, what the paywall claims]
const FEATURES = [
  ['Study Mode',            'src/app/study.tsx',                 'isPro',        'pro'],
  ['Duels',                 'src/app/challenges/index.tsx',      'isPremium',    'premium'],
  ['Ready Room leaderboard','src/app/ready-room.tsx',            'isPro',        'pro'],
  ["What's Changed",        'src/app/whats-changed.tsx',         'hasPlusAccess','plus'],
  ['RefPacks',              'src/app/ref-packets/[code].tsx',    'hasPlusAccess','plus'],
  ['My Aircraft',           'src/app/my-aircraft/index.tsx',     'isPro',        'pro'],
  ['Back up & sync',        'src/app/(tabs)/saved.tsx',          'isPro',        'pro'],
  ['Offline download',      'src/app/far/[id].tsx',              'isPremium',    'premium'],
  ['Share / export',        'src/app/far/[id].tsx',              'hasPlusAccess','plus'],
  ['Print',                 'src/app/far/[id].tsx',              'hasPlusAccess','plus'],
  ['Share a folder',        'src/app/folder/[id].tsx',           'isPremium',    'premium'],
  ['Community tab',         'src/app/(tabs)/search.tsx',         'hasPlusAccess','plus'],
  ['DailyReg card',         'src/app/(tabs)/index.tsx',          'hasPlusAccess','plus'],
]

const evalGate = (flag, tier) =>
  flag === 'hasPlusAccess' ? has(tier) : TIERS[tier][flag]

const CLAIM_MIN = { plus: ['plus', 'pro', 'premium'], pro: ['pro', 'premium'], premium: ['premium'] }

let problems = 0
console.log('FEATURE                    GATE            free  plus  pro   prem   paywall says')
console.log('-'.repeat(88))
for (const [name, file, flag, claim] of FEATURES) {
  // Confirm the gate flag really appears in that file.
  let src = ''
  try { src = readFileSync(file, 'utf8') } catch { console.log(`  !! missing ${file}`); problems++; continue }
  if (!src.includes(flag)) {
    console.log(`  !! ${name}: ${flag} not found in ${file}`)
    problems++
    continue
  }
  const row = ['free', 'plus', 'pro', 'premium'].map((t) => (evalGate(flag, t) ? ' YES ' : '  -  '))
  console.log(`${name.padEnd(26)} ${flag.padEnd(15)} ${row.join(' ')}  ${claim}`)

  // The tiers that CAN use it must be exactly the tiers at/above the claim.
  const allowed = ['free', 'plus', 'pro', 'premium'].filter((t) => evalGate(flag, t))
  const expected = CLAIM_MIN[claim]
  if (JSON.stringify(allowed) !== JSON.stringify(expected)) {
    console.log(`     MISMATCH: gate allows [${allowed}] but paywall sells it as ${claim} (expected [${expected}])`)
    problems++
  }
  if (evalGate(flag, 'free')) {
    console.log(`     LEAK: a FREE user can use ${name}`)
    problems++
  }
}
console.log('-'.repeat(88))

// ---------------------------------------------------------------------------
// The table above is hand-maintained, which means it can go STALE and report a
// false green -- it did exactly that after Share/export moved from isPremium
// to hasPlusAccess. Cross-check every claim against the real source so a
// drifted row fails loudly instead of passing quietly.
const REG_SCREENS = ['src/app/ac/[id].tsx','src/app/far/[id].tsx','src/app/aim/[id].tsx',
                     'src/app/pcg/[id].tsx','src/app/ad/[id].tsx','src/app/loi/[slug].tsx']
let drift = 0
console.log('\nCROSS-CHECK: the gate each handler actually uses')
for (const f of REG_SCREENS) {
  const src = _read(f, 'utf8')
  for (const [handler, expected] of [['handleShare','hasPlusAccess'], ['handlePrint','hasPlusAccess'], ['handleDownload','isPremium']]) {
    const i = src.indexOf(`const ${handler} =`)
    if (i < 0) continue
    const window_ = src.slice(i, i + 420)
    // Look for a NEGATED TIER FLAG specifically. Matching the first
    // `if (!x)` instead picked up the null-guard (`if (!section) return`)
    // and reported six false drifts, because the download gate is written
    // `if (!isPremium && !downloaded)` -- no closing paren after the flag.
    const m = window_.match(/!\s*(hasPlusAccess|isPro|isPremium)\b/)
    const actual = m ? m[1] : '(none)'
    if (actual !== expected) {
      console.log(`  DRIFT ${f} ${handler} gates on ${actual}, table says ${expected}`)
      drift++
    }
  }
}
console.log(drift ? `  ${drift} drifted gate(s)` : '  all reg-screen handlers match the table')

console.log('-'.repeat(88))
const total = problems + drift
console.log(total ? `${total} PROBLEM(S)` : 'Every gate matches its advertised tier, and nothing leaks to free.')
process.exit(total ? 1 : 0)
