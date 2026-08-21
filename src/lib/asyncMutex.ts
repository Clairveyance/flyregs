// Per-key async mutex for AsyncStorage read-modify-write cycles.
//
// Built for the sync race found in the 2026-08-21 bug sweep: sync.ts's
// pullAndMergeAll snapshots local state, awaits a network round-trip, then
// writes a merged result back -- with nothing stopping a concurrent local
// mutation (addBookmark, folder add/remove, a note edit) from doing its own
// independent read-modify-write in that window and getting silently
// reverted the moment the merge's own write lands after it.
//
// Lock domains are coarse on purpose: 'bookmarks', 'folders' (covers BOTH
// the folders and folder-items AsyncStorage keys -- deleteFolder/
// duplicateFolder touch both together, and giving them one shared domain
// instead of two separate locks avoids any lock-ordering/deadlock question
// entirely, at the cost of a folder rename briefly serializing against an
// unrelated folder-item add, which is not a meaningful perf concern for
// this app), and 'notes'.
//
// Only wrap the LEAF read-modify-write functions with withLock, never a
// function that itself calls another locked function (e.g. duplicateFolder
// calls createFolder + addManyToFolder, both already locked -- wrapping
// duplicateFolder too would deadlock against its own sub-calls, since a
// plain queue-per-key mutex isn't reentrant). removeBookmark/
// removeHighlight/addToFolder/removeItemFromAllFolders are thin delegates
// to an already-locked sibling and don't need (and must not get) their own
// lock for the same reason.

const queues = new Map<string, Promise<unknown>>()

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  // Chain onto prev regardless of whether it succeeded or failed, so one
  // failed operation doesn't permanently wedge every later operation on the
  // same key.
  const run = prev.catch(() => {}).then(fn)
  // The queue's own stored promise must never reject either, for the same
  // reason -- the REAL success/failure is still delivered to this call's
  // caller via the returned `run` promise below, unaffected.
  queues.set(key, run.catch(() => {}))
  return run
}
