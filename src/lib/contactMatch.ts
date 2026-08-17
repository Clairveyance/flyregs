import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

// Core layer for RC's approved contact/invite feature -- see
// sync/migrations_contact_match.sql for the server side (email) and
// sync/migrations_contact_match_phone.sql (phone, added later -- RC:
// "let's do the phone addition your way. make it optional and prompt it
// contextually", after this file's own empty-address-book self-diagnosis
// below proved out: most real phone contacts have a number saved, not an
// email). Same privacy shape as WhatsApp/Signal contact discovery: hash
// locally, send only hashes, get back only the matched user's already-
// public callsign -- raw contact emails/phones never leave the device, and
// the searcher's own contact list is never visible to anyone else,
// including the matched user. Phone is NOT auth -- this app stays
// email/magic-link only -- just an optional, unverified matching-only
// field in user_metadata, same trust model as an unverified device
// contact's own saved number.
export interface DeviceContact {
  id: string
  name: string
  emails: string[]
  phones: string[]
}

// expo-contacts/expo-crypto are dynamically imported (not top-level) --
// RC, real device: "phone dev is erroring out in a/c, folders, etc --
// anywhere it seems you were working on contacts/invites." Root cause:
// expo-contacts ships its native binding as ExpoContactsNext, resolved
// via requireNativeModule, which throws immediately at IMPORT time (not
// call time) on any dev-client build that predates this dependency being
// added -- exactly the already-tracked "Cannot find native module
// ExpoContactsNext" Sentry crash. A static top-level import in
// contactMatch.ts meant every screen that merely imports FindFriendsSheet
// (aircraft, folder) pulled that native binding in immediately just by
// being opened, whether or not the user ever taps "Find Friends" -- so a
// stale dev-client build crashed on screens that have nothing to do with
// contacts. Deferring the import to inside each function means the native
// module is only touched at the moment it's actually used.
async function hashEmail(email: string): Promise<string> {
  const Crypto = await import('expo-crypto')
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    email.trim().toLowerCase(),
    { encoding: Crypto.CryptoEncoding.HEX }
  )
}

// MUST exactly match public.normalize_phone in
// migrations_contact_match_phone.sql, or a real match will silently never
// hash-equal -- strips everything but digits, and assumes a bare 10-digit
// number is a US number missing its country code.
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length === 10 ? `1${digits}` : digits
}

async function hashPhone(phone: string): Promise<string> {
  const Crypto = await import('expo-crypto')
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    normalizePhone(phone),
    { encoding: Crypto.CryptoEncoding.HEX }
  )
}

export function getMyPhoneNumber(session: Session | null): string | null {
  return (session?.user?.user_metadata as { phone_number?: string } | undefined)?.phone_number ?? null
}

export async function setMyPhoneNumber(phone: string | null): Promise<void> {
  const trimmed = phone?.trim() || null
  const { error } = await supabase.auth.updateUser({ data: { phone_number: trimmed } })
  if (error) throw error
}

export interface ContactsPermissionResult {
  granted: boolean
  // iOS 18+ Limited Access: granted:true but only for a subset of contacts
  // (possibly zero) the user explicitly picked -- see getDeviceContacts's
  // own comment for why this matters. 'all'/'none' on older iOS/Android.
  limited: boolean
}

export async function requestContactsPermission(): Promise<ContactsPermissionResult> {
  const Contacts = await import('expo-contacts')
  const existing = await Contacts.getPermissionsAsync()
  const perm = existing.granted ? existing : await Contacts.requestPermissionsAsync()
  return { granted: perm.granted, limited: perm.accessPrivileges === 'limited' }
}

// Re-invokes iOS 18's native "Select Contacts" picker so the user can add
// more contacts to their Limited Access grant without leaving the app.
export async function presentContactsAccessPicker(): Promise<void> {
  const Contacts = await import('expo-contacts')
  await Contacts.Contact.presentAccessPicker()
}

// RC, real device: "this doesn't DO anything. This is a contact search
// area. it needs to 'connect' to and bring up my iOS phone contact book."
// The original design silently fetched only EMAILS and showed nothing
// but a flat list of matches -- for most real address books (people save
// phone numbers, not emails, for personal contacts) that's an empty or
// near-empty list forever, which reads exactly like "does nothing." This
// mirrors BulkInviteContactPicker.tsx's already-proven pattern (real
// name+contact list, not a silent background match) instead.
export async function getDeviceContacts(): Promise<DeviceContact[]> {
  const Contacts = await import('expo-contacts')
  const data = await Contacts.Contact.getAllDetails(
    [Contacts.ContactField.FULL_NAME, Contacts.ContactField.EMAILS, Contacts.ContactField.PHONES],
    { sortOrder: Contacts.ContactsSortOrder.GivenName },
  )
  return (data as any[])
    .filter((c) => c.fullName)
    .map((c) => ({
      id: (c.id as string) ?? c.fullName!,
      name: c.fullName as string,
      emails: ((c.emails ?? []) as { address?: string }[]).map((e) => e.address).filter((e): e is string => !!e),
      phones: ((c.phones ?? []) as { number?: string }[]).map((p) => p.number).filter((n): n is string => !!n),
    }))
}

// Given the CALLER's own already-loaded device contacts, ask the server
// which are already discoverable FlyRegs accounts. Hashes locally, sends
// only hashes -- never a raw email. Returns contactId -> callsign (not a
// flat list of callsigns) so the caller can annotate its REAL contact
// list with which entries are already on FlyRegs, rather than only ever
// being able to show an unattributed pile of matches.
export async function matchContactsToCallsigns(contacts: DeviceContact[]): Promise<Map<string, string>> {
  const emailToContactId = new Map<string, string>()
  const phoneToContactId = new Map<string, string>()
  for (const c of contacts) {
    for (const e of c.emails) {
      if (!emailToContactId.has(e)) emailToContactId.set(e, c.id)
    }
    for (const p of c.phones) {
      if (!phoneToContactId.has(p)) phoneToContactId.set(p, c.id)
    }
  }
  const emails = [...emailToContactId.keys()]
  const phones = [...phoneToContactId.keys()]
  const result = new Map<string, string>()
  if (emails.length === 0 && phones.length === 0) return result

  const hashToEmail = new Map<string, string>()
  const hashToPhone = new Map<string, string>()
  const [emailHashes, phoneHashes] = await Promise.all([
    Promise.all(emails.map(async (e) => {
      const h = await hashEmail(e)
      hashToEmail.set(h, e)
      return h
    })),
    Promise.all(phones.map(async (p) => {
      const h = await hashPhone(p)
      hashToPhone.set(h, p)
      return h
    })),
  ])

  const [emailResult, phoneResult] = await Promise.all([
    emailHashes.length
      ? supabase.rpc('match_contacts_by_email', { p_email_hashes: emailHashes })
      : Promise.resolve({ data: [] as { email_hash: string; callsign: string }[], error: null }),
    phoneHashes.length
      ? supabase.rpc('match_contacts_by_phone', { p_phone_hashes: phoneHashes })
      : Promise.resolve({ data: [] as { phone_hash: string; callsign: string }[], error: null }),
  ])
  if (emailResult.error) throw emailResult.error
  if (phoneResult.error) throw phoneResult.error

  for (const row of (emailResult.data ?? []) as { email_hash: string; callsign: string }[]) {
    const email = hashToEmail.get(row.email_hash)
    const contactId = email ? emailToContactId.get(email) : undefined
    if (contactId) result.set(contactId, row.callsign)
  }
  // Applied second -- most real address books have a number saved for
  // someone, not an email (this file's own original motivation for adding
  // phone matching at all), so a phone match is the more likely-correct
  // signal if a contact's entries somehow matched on both.
  for (const row of (phoneResult.data ?? []) as { phone_hash: string; callsign: string }[]) {
    const phone = hashToPhone.get(row.phone_hash)
    const contactId = phone ? phoneToContactId.get(phone) : undefined
    if (contactId) result.set(contactId, row.callsign)
  }
  return result
}

// Every invite path in the app (aircraft/folder) already resolves a
// Callsign to a user SERVER-SIDE inside the invite RPC itself
// (invite_aircraft_collaborator's p_callsign, etc.) -- no separate lookup
// needed there. Ready Room's "tap a match to view their profile" is the
// one place that genuinely needs the userId client-side first, since
// profile/[userId].tsx routes by id, not by Callsign.
export async function resolveCallsignToUserId(callsign: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('lookup_user_by_callsign', { p_callsign: callsign })
  if (error) throw error
  return data?.[0]?.out_user_id ?? null
}

export interface VisibleUser {
  userId: string
  displayLabel: string
}

// RC: "if all 'visible' users show up in RR, then that should be another
// way of searching/finding someone... along w/ 'search callsign' we
// should have the ability to scroll the RR list for people." Everyone
// who's opted into "Show me on the Ready Room leaderboard" (Account >
// The Wing), regardless of whether they've actually studied/dueled yet --
// broader than any single Ready Room tab, which each also require real
// activity in that dimension. See get_visible_users' own migration
// comment for why this isn't just get_challengeable_users() reused (that
// one is Duels-specific and Premium-filtered).
export async function getVisibleUsers(): Promise<VisibleUser[]> {
  const { data, error } = await supabase.rpc('get_visible_users')
  if (error) throw error
  return (data ?? []).map((row: any) => ({ userId: row.user_id, displayLabel: row.display_label }))
}
