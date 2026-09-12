import { useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { AvatarCircle } from '@/components/AvatarCircle'
import { searchUsersForInvite, type InviteSearchResult } from '@/lib/contactMatch'

// RC, 2026-09-11: "we need the 'invite' search popup for all places (duels,
// folders, a/c, etc) capable of searching everything in the one search bar --
// Callsign, phone number, email, etc. some users may not know another's
// callsign, but have their phone."
//
// Every invite surface used to have its own Callsign-only field with its own
// copy of the check-then-add dance (Duels' opponent chooser, the folder invite
// modal, the aircraft invite modal). Someone holding a student's phone number
// but not their callsign simply could not invite them. This is the one field
// they all use now, so a fix to the search behaviour lands everywhere at once
// instead of in whichever surface happened to get it.
//
// Phone formatting is NOT normalised here. The rule has to match what is
// stored, and that rule lives in the database (normalize_phone), so the raw
// string goes to the server exactly as typed -- digits, dashes, spaces,
// parens and +1 all resolve there.

const DEBOUNCE_MS = 280

export function ContactSearchField({
  placeholder = 'Callsign, phone, or email',
  onSelect,
  excludeUserIds = [],
  /**
   * Duels only. `duelReady` mirrors create_challenge's gate (opted in to the
   * Ready Room leaderboard AND on Premium), so a row it marks false is one
   * the server WILL reject -- better to say so here than after they've been
   * added and Start Duel fails. Folders and aircraft have no such gate.
   */
  requireDuelReady = false,
  requireCallsign = false,
  autoFocus = false,
}: {
  placeholder?: string
  onSelect: (user: InviteSearchResult) => void
  excludeUserIds?: string[]
  requireDuelReady?: boolean
  /**
   * Folder and aircraft invites go through inviteCollaboratorByCallsign, so a
   * user who has never set a Callsign can be FOUND by phone or email but not
   * invited that way. Say so on the row instead of letting the invite fail
   * after they've picked someone. Duels invite by user id and don't need this.
   */
  requireCallsign?: boolean
  autoFocus?: boolean
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<InviteSearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  // Only the newest query may write results -- without this a slow early
  // request can land after a fast later one and repopulate the list with
  // matches for text the user has already replaced.
  const seq = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearched(false); setError(null); return }
    const mine = ++seq.current
    setBusy(true)
    const t = setTimeout(() => {
      searchUsersForInvite(q)
        .then((rows) => {
          if (mine !== seq.current) return
          setResults(rows.filter((r) => !excludeUserIds.includes(r.userId)))
          setError(null)
          setSearched(true)
        })
        .catch((e: any) => {
          if (mine !== seq.current) return
          // A failed lookup is NOT "no such user". Saying "not found" when the
          // request never completed is how an invite looks impossible when it
          // is merely offline.
          setResults([])
          setSearched(false)
          setError(e?.message?.includes('requires Pro')
            ? 'Inviting requires Pro.'
            : "Couldn't search right now. Check your connection and try again.")
        })
        .finally(() => { if (mine === seq.current) setBusy(false) })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, excludeUserIds.join(',')])

  const hint = (r: InviteSearchResult) =>
    r.matchKind === 'phone' ? 'matched by phone number'
    : r.matchKind === 'email' ? 'matched by email'
    : null

  return (
    <View>
      <View style={[styles.inputWrap, { borderColor: error ? tokens.red : tokens.bdr, backgroundColor: tokens.bg2 }]}>
        <Icon name="magnifyingglass" size={fs(15)} color={tokens.t3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          placeholderTextColor={tokens.t4}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          // A single field takes a callsign, a phone number OR an email, so no
          // keyboardType is right for all three -- 'default' is the only one
          // that can type all of them. (email-address hides the digits row on
          // some layouts; phone-pad hides the letters entirely.)
          keyboardType="default"
          style={{ flex: 1, color: tokens.t1, fontSize: ifs(15), paddingVertical: 10 }}
        />
        {busy && <ActivityIndicator size="small" color={tokens.t3} />}
        {!busy && query.length > 0 && (
          <Pressable onPress={() => setQuery('')} hitSlop={10}>
            <Icon name="xmark.circle.fill" size={fs(15)} color={tokens.t4} />
          </Pressable>
        )}
      </View>

      {error ? (
        <Text style={{ color: tokens.red, fontSize: fs(12.5), marginTop: 6 }}>{error}</Text>
      ) : null}

      {!error && searched && results.length === 0 ? (
        <Text style={{ color: tokens.t3, fontSize: fs(12.5), marginTop: 6 }}>
          No FlyRegs user found. A phone number or email has to match exactly; a callsign
          can be the first few letters.
        </Text>
      ) : null}

      {results.map((r) => {
        // Name the real reason. The old Duels copy ("hasn't enabled Duel
        // challenges yet") pointed at a setting that doesn't exist, so anyone
        // who went looking found their Duel Alerts already on and had nowhere
        // to go.
        const blockedReason =
          requireCallsign && !r.callsign
            ? "Hasn't set a Callsign yet -- they need one to be invited"
            : requireDuelReady && !r.duelReady
              ? "Not on Premium -- can't be added to a Duel"
              : null
        const blocked = blockedReason !== null
        return (
          <Pressable
            key={r.userId}
            onPress={() => { if (!blocked) { onSelect(r); setQuery('') } }}
            disabled={blocked}
            style={[styles.row, { borderBottomColor: tokens.bdr, opacity: blocked ? 0.55 : 1 }]}
          >
            <AvatarCircle
              imageUri={r.avatarUrl}
              presetId={r.avatarPreset}
              fallbackLabel={r.callsign ?? '?'}
              size={fs(30)}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: tokens.t1, fontSize: fs(14.5), fontWeight: '600' }} numberOfLines={1}>
                {r.callsign ?? 'Pilot'}
              </Text>
              {/* RC: finding someone by a number you already have is how you
                  learn their callsign. Saying WHICH field matched makes that
                  explicit rather than leaving the user to guess. */}
              {hint(r) ? (
                <Text style={{ color: tokens.t3, fontSize: fs(11.5) }}>{hint(r)}</Text>
              ) : null}
              {blockedReason ? (
                <Text style={{ color: tokens.amb, fontSize: fs(11.5) }}>{blockedReason}</Text>
              ) : null}
            </View>
            {!blocked && <Icon name="plus.circle.fill" size={fs(20)} color={tokens.blu} />}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 12,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
})
