import { useCallback, useEffect } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'

/**
 * The refresh contract for any screen two people can look at AT THE SAME TIME.
 *
 * RC has reported this class repeatedly, most sharply as Adriana's
 * "I see your edits but you can't see mine after the file is shared", and again
 * on 2026-09-17: "owners of shared material giving r/w perms were then unable to
 * see changes made by guests".
 *
 * A shared screen needs FOUR triggers, and each covers a hole the others leave:
 *
 *   1. ON FOCUS          -- the obvious one, and the only one this app had at
 *                           first. It fires on REACT NAVIGATION focus only.
 *   2. ON APP FOREGROUND -- a real phone is locked and unlocked constantly while
 *                           this screen stays the topmost route, so it never
 *                           unfocuses in the navigation sense and (1) never runs.
 *   3. REALTIME PUSH     -- passed in by the caller, since the channel differs
 *                           per resource. Instant when it works.
 *   4. A PERIODIC FLOOR  -- the one that keeps getting forgotten, and the reason
 *                           this hook exists.
 *
 * WHY (4) IS NOT OPTIONAL. Two people reviewing a shared folder or aircraft
 * together sit on one screen, in the foreground, for a long stretch: (1) never
 * fires because they never navigate, (2) never fires because they never
 * background, and (3) can die silently -- a Wi-Fi/carrier handoff, or any
 * dropped websocket -- with nothing to notice or recover it. Without a floor,
 * the window in which an owner cannot see a guest's edit is UNBOUNDED. With
 * one, the worst case is one interval.
 *
 * Both folder screens were given this on 2026-08-30. my-aircraft/[id].tsx was
 * not -- its own comment says it got "the same two-part fix as both folder
 * screens got earlier", and the third part landed on the folders afterwards and
 * was never carried across. That is why this is now a shared hook instead of a
 * pattern to remember: a new shared screen gets all four or none.
 */
const DEFAULT_FLOOR_MS = 45_000

export function useSharedScreenRefresh(
  load: () => void,
  opts: {
    intervalMs?: number
    /**
     * Used for the periodic tick ONLY, when a silent refresh is available.
     * folder/shared/[id].tsx needs this: its `load()` shows a first-paint
     * spinner, and running that every 45s would blank the screen out from under
     * someone who is reading it. Defaults to `load` when a screen has no
     * separate quiet path.
     */
    periodic?: () => void
  } = {},
) {
  const { intervalMs = DEFAULT_FLOOR_MS, periodic } = opts
  const tick = periodic ?? load
  // (1) focus + (4) the periodic floor, together, so the timer only runs while
  // the screen is actually being looked at -- a background timer polling the
  // network would be a battery cost for nothing.
  useFocusEffect(
    useCallback(() => {
      load()
      const timer = setInterval(tick, intervalMs)
      return () => clearInterval(timer)
    }, [load, tick, intervalMs]),
  )

  // (2) OS foreground. Separate from the above on purpose: useFocusEffect does
  // not fire when iOS merely resumes the app.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load()
    })
    return () => sub.remove()
  }, [load])
}
