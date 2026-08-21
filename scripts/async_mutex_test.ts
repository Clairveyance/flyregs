#!/usr/bin/env npx tsx
/**
 * Deterministic concurrency proof for src/lib/asyncMutex.ts, the fix for the
 * 2026-08-21 sync-clobber race: sync.ts's pullAndMergeAll (and
 * syncFolderFromCloud) used to snapshot local AsyncStorage, await a network
 * round-trip, then blindly overwrite from that stale snapshot -- a
 * concurrent local write (addBookmark, folder add/remove, a note edit)
 * landing in that window got silently reverted the moment the merge's own
 * write landed after it.
 *
 * This can't be exercised on a real device/simulator from this environment
 * (see gotcha_no_xcode_simulator_access.md), and the race needs sub-second
 * timing control a live device wouldn't give reliable access to anyway --
 * so instead of hoping to hit the window empirically, this simulates the
 * exact interleaving directly against the real withLock import, which
 * proves the fix's actual concurrency semantics deterministically rather
 * than by observation.
 *
 * Usage: npx tsx scripts/async_mutex_test.ts
 */
import { withLock } from '../src/lib/asyncMutex'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

let failures = 0
function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`)
  if (!cond) failures++
}

async function main() {
  console.log('=== asyncMutex.ts concurrency proof ===\n')

  // TEST 1: the exact shape of the real bug (merge reads a snapshot, awaits
  // a "network round-trip", re-reads fresh, writes) racing a fast local
  // write on the SAME key -- both writes must survive.
  {
    let store: string[] = ['a']
    const slowMerge = withLock('k', async () => {
      await sleep(50) // stand-in for the network round-trip
      const fresh = [...store] // the actual fix: re-read fresh under the lock
      store = [...new Set([...fresh, 'from-remote'])]
    })
    await sleep(5) // let slowMerge grab the lock first
    const fastWrite = withLock('k', async () => {
      store = [...store, 'from-local-write']
    })
    await Promise.all([slowMerge, fastWrite])
    check(
      'race on the same key serializes -- both writes survive',
      store.includes('from-remote') && store.includes('from-local-write'),
      JSON.stringify(store)
    )
  }

  // TEST 2 (control): the SAME scenario with NO lock at all -- proves the
  // underlying race is real, not a strawman, by reproducing the actual data
  // loss it causes.
  {
    let store: string[] = ['a']
    async function unsafeMerge() {
      const staleSnapshot = [...store]
      await sleep(50)
      store = [...new Set([...staleSnapshot, 'from-remote'])] // the ORIGINAL bug: no re-read
    }
    const p1 = unsafeMerge()
    await sleep(5)
    const p2 = (async () => {
      store = [...store, 'from-local-write']
    })()
    await Promise.all([p1, p2])
    check(
      'control (unlocked): local write IS silently lost, confirming the bug is real',
      !store.includes('from-local-write'),
      JSON.stringify(store)
    )
  }

  // TEST 3: a failed operation must not permanently wedge the queue for
  // every later operation on the same key.
  {
    let ranAfterFailure = false
    await withLock('k2', async () => {
      throw new Error('boom')
    }).catch(() => {})
    await withLock('k2', async () => {
      ranAfterFailure = true
    })
    check('a failed operation does not wedge the queue', ranAfterFailure)
  }

  // TEST 4: different lock domains ('bookmarks' vs 'folders' vs 'notes' in
  // production) must NOT serialize against each other -- only same-key
  // operations should queue.
  {
    const order: string[] = []
    const a = withLock('domainA', async () => {
      await sleep(30)
      order.push('A')
    })
    const b = withLock('domainB', async () => {
      order.push('B')
    })
    await Promise.all([a, b])
    check('different keys run independently (B finishes first, not queued behind A)', order[0] === 'B', JSON.stringify(order))
  }

  // TEST 5: stress -- many concurrent operations on one key, none lost.
  {
    let store: number[] = []
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => withLock('stress', async () => { store = [...store, i] }))
    )
    check('50 concurrent writes on one key, none lost', new Set(store).size === 50, String(store.length))
  }

  console.log(`\n${failures === 0 ? 'ALL ASYNC-MUTEX CHECKS PASSED' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
