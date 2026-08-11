// Natural-sort two identifiers so numeric segments compare as integers, not
// as a single parsed number. "61.100" and "61.63" as a whole via
// parseFloat() are 61.1 and 61.63 -- parseFloat reads everything after the
// decimal point as a FRACTION, so "61.100" (fraction .1) sorts as if it
// were "61.1", landing it before "61.63" and, worse, making the comparator
// inconsistent (an === bn for "61.1"/"61.10"/"61.100" all alike) -- an
// invalid comparator doesn't just mis-order a pair, it can make
// Array.prototype.sort scramble entire unrelated groups, which is exactly
// what happened to FAR Part 61's own section list (found live, RC:
// "notice 61.63 doesn't show up in order" -- it wasn't missing, Subpart B
// had been sorted to the very end of the whole part).
//
// This splits on numeric runs and compares each segment as its own
// integer ("20" vs "197" as 20 and 197, not "20.197" as one float) --
// exactly how series/[prefix].tsx already, correctly, sorts AC document
// numbers ("20-24D" < "20-197" because 24 < 197). Extracted here so
// far/part/[part].tsx and far/[id].tsx -- which had each re-implemented
// this as a broken parseFloat version instead of reusing the correct
// one -- and series/[prefix].tsx all share one proven implementation.
const NUMERIC_RUN = /(\d+)/g

export function naturalCompare(a: string, b: string): number {
  const ap = a.split(NUMERIC_RUN)
  const bp = b.split(NUMERIC_RUN)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? ''
    const bv = bp[i] ?? ''
    const an = parseInt(av, 10)
    const bn = parseInt(bv, 10)
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn
    } else if (av !== bv) {
      return av.localeCompare(bv)
    }
  }
  return 0
}
