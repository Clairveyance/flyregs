import { supabase } from '@/lib/supabase'

// Self-attested "bragging rights" badges -- never treat these as verified
// credentials anywhere in the UI (copy must always read as self-reported,
// e.g. a LinkedIn-style claim, not a FlyRegs-issued certification). See the
// pricing/positioning discussion for why this stays unverified by design:
// it's a much smaller trust/liability surface than the on-device-only
// certificate-image idea it replaced.
export const RATING_CODES = [
  // Certificates
  'STUDENT', 'SPORT', 'REC', 'PPL', 'COMM', 'ATP',
  // Category/class ratings
  'ASEL', 'ASES', 'AMEL', 'AMES', 'HELI', 'GYRO', 'GLIDER', 'AIRSHIP', 'BALLOON', 'POWLIFT',
  // Instrument
  'IR',
  // Instructor
  'CFI', 'CFII', 'MEI', 'GI',
  // Maintenance
  'A&P', 'IA',
  // Other
  'DPE', 'FE', 'PART107', 'DISPATCHER',
] as const
export type RatingCode = typeof RATING_CODES[number]

export const RATING_LABELS: Record<RatingCode, string> = {
  STUDENT: 'Student Pilot',
  SPORT: 'Sport Pilot',
  REC: 'Recreational Pilot',
  PPL: 'Private Pilot',
  COMM: 'Commercial Pilot',
  ATP: 'ATP',
  ASEL: 'ASEL',
  ASES: 'ASES',
  AMEL: 'AMEL',
  AMES: 'AMES',
  HELI: 'Helicopter',
  GYRO: 'Gyroplane',
  GLIDER: 'Glider',
  AIRSHIP: 'Airship',
  BALLOON: 'Balloon',
  POWLIFT: 'Powered Lift',
  IR: 'Instrument Rating',
  CFI: 'CFI',
  CFII: 'CFII',
  MEI: 'MEI',
  GI: 'Ground Instructor',
  'A&P': 'A&P Mechanic',
  IA: 'Inspection Authorization',
  DPE: 'DPE',
  FE: 'Flight Engineer',
  PART107: 'Part 107 Remote Pilot',
  DISPATCHER: 'Dispatcher',
}

// Short forms for display chips (Account, Community profile, Home preview)
// -- RATING_LABELS' full names ("Commercial Pilot", "Instrument Rating")
// read fine in the +Add Rating picker but don't fit as compact pills stacked
// next to each other. Deliberately its own map rather than derived from
// RATING_CODES: several codes (COMM, HELI, GYRO) aren't the abbreviation a
// pilot would actually recognize on a badge.
export const RATING_SHORT_LABELS: Record<RatingCode, string> = {
  STUDENT: 'STU',
  SPORT: 'SPT',
  REC: 'REC',
  PPL: 'PPL',
  COMM: 'COM',
  ATP: 'ATP',
  ASEL: 'ASEL',
  ASES: 'ASES',
  AMEL: 'AMEL',
  AMES: 'AMES',
  HELI: 'HELI',
  GYRO: 'GYRO',
  GLIDER: 'GLI',
  AIRSHIP: 'AIR',
  BALLOON: 'BAL',
  POWLIFT: 'PL',
  IR: 'IR',
  CFI: 'CFI',
  CFII: 'CFII',
  MEI: 'MEI',
  GI: 'GI',
  'A&P': 'A&P',
  IA: 'IA',
  DPE: 'DPE',
  FE: 'FE',
  PART107: 'P107',
  DISPATCHER: 'DISP',
}

// Grouping for the "+Add Rating" picker so 27 codes don't read as one flat
// wall of checkboxes -- purely a UI organization aid, not a DB concept.
export const RATING_GROUPS: { label: string; codes: RatingCode[] }[] = [
  { label: 'Certificates', codes: ['STUDENT', 'SPORT', 'REC', 'PPL', 'COMM', 'ATP'] },
  { label: 'Category / Class', codes: ['ASEL', 'ASES', 'AMEL', 'AMES', 'HELI', 'GYRO', 'GLIDER', 'AIRSHIP', 'BALLOON', 'POWLIFT'] },
  { label: 'Instrument', codes: ['IR'] },
  { label: 'Instructor', codes: ['CFI', 'CFII', 'MEI', 'GI'] },
  { label: 'Maintenance', codes: ['A&P', 'IA'] },
  { label: 'Other', codes: ['DPE', 'FE', 'PART107', 'DISPATCHER'] },
]

export async function getMyRatings(userId: string): Promise<RatingCode[]> {
  const { data, error } = await supabase
    .from('user_profile_ratings')
    .select('rating_code')
    .eq('user_id', userId)
  if (error) return []
  return (data ?? []).map((r) => r.rating_code as RatingCode)
}

export async function addRating(userId: string, code: RatingCode): Promise<void> {
  const { error } = await supabase.from('user_profile_ratings').insert({ user_id: userId, rating_code: code })
  if (error && error.code !== '23505') throw error // 23505 = already added, harmless no-op
}

export async function removeRating(userId: string, code: RatingCode): Promise<void> {
  const { error } = await supabase
    .from('user_profile_ratings')
    .delete()
    .eq('user_id', userId)
    .eq('rating_code', code)
  if (error) throw error
}
