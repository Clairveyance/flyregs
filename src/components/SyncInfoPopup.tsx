import { InfoPopup } from '@/components/InfoPopup'
import { useTheme } from '@/context/theme'

// The "what does Back up & sync actually cover" explainer.
//
// RC, 2026-09-04: "we should prob add one of the info icons next to the bu/s
// toggles in the app, informing of this, letting users know all settings will
// transfer, etc. it should also clearly bullet list the two 'groups' you named
// above - so users see clearly what features need bu/s and which don't."
//
// ONE COMPONENT, TWO CALL SITES. The toggle appears on both Saved and Notes,
// and a copy of this list beside each would drift the first time a setting is
// added -- which is the exact failure this codebase keeps finding (the tier
// table vs the paywall, the quizzable views vs the CHECK constraint). The
// content lives here and both screens render the same thing.
//
// The three groups are not a guess. scripts/cross_device_parity_test.ts drives
// two device stores against one real account and measures which category every
// surface actually falls into; this list is that output written out in the
// user's language. If the test's grouping changes, this copy is wrong and
// should change with it.
export function SyncInfoPopup({ iconSize = 14 }: { iconSize?: number }) {
  const { tokens } = useTheme()
  return (
    <InfoPopup
      id="backup-sync-what-transfers"
      title="What syncs between your devices"
      iconSize={iconSize}
      body={[
        // Colour marks the heading of each group so the three are separable
        // at a glance in a small popup -- the thing a flat run of identical
        // bullets makes hard.
        { text: 'Turn Back up & sync ON and these follow you to any device signed into the same account:', color: tokens.gold },
        { text: 'Bookmarks and highlights', indent: true },
        { text: 'Notes', indent: true },
        { text: 'Folders, and everything in them', indent: true },
        { text: 'Appearance, Red Shift and text size', indent: true },
        { text: 'Badge duration', indent: true },
        { text: 'Study session size, card direction and your filter picks', indent: true },

        { text: 'These are already on every device the moment you sign in — no toggle needed:', color: tokens.gold },
        { text: 'My Fleet, your equipment and your reminders', indent: true },
        { text: 'AD alerts you follow', indent: true },
        { text: 'Study progress and mastery', indent: true },
        { text: 'Duel record, coins and trophies', indent: true },
        { text: 'Streak and leaderboard settings', indent: true },
        { text: 'Your callsign, photo and ratings', indent: true },
        { text: 'Which documents you have downloaded', indent: true },

        { text: 'These stay on the device you set them on:', color: tokens.t3 },
        { text: 'Recently viewed and recent searches', indent: true },
        { text: 'The downloaded files themselves — download again on the other device to read offline there', indent: true },
        { text: 'Face ID / Touch ID sign-in', indent: true },

        // RC's own scenario: two devices, sync off on both, each with its
        // own history -- then sync goes on. Content merges, so nothing is
        // lost; settings cannot merge, so one device has to win. Saying which
        // one, in advance, is the difference between a rule and a surprise.
        { text: 'Turning it on for the first time, with two devices:', color: tokens.gold },
        { text: 'Nothing is erased. Bookmarks, notes and folders from both devices are combined, so you end up with everything from each.', indent: true },
        { text: 'Settings cannot combine — there is no mix of Dark and Light. The first device you turn sync on sets them for the account, and any device you turn it on afterwards adopts those settings.', indent: true },
        { text: 'After that, changing a setting on either device changes it everywhere.', indent: true },

        'Back up & sync is a Pro feature. It also means your notes, bookmarks and folders survive a reinstall.',
      ]}
    />
  )
}
