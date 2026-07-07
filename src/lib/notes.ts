import AsyncStorage from '@react-native-async-storage/async-storage'

const NOTES_KEY = '@flyregs/notes'

export interface Note {
  id: string
  title: string
  body: string
  linked_ac: string | null
  updated_at: string
}

const SEED_NOTES: Note[] = [
  {
    id: 'seed-1',
    title: 'CFI checkride prep',
    body: 'Re-read 61-65K on flight instructor endorsements before the ride. Confirm the §61.195 limitations and the spin-training endorsement wording.',
    linked_ac: '61-65K',
    updated_at: new Date(Date.now() - 172_800_000).toISOString(),
  },
  {
    id: 'seed-2',
    title: 'Icing brief for students',
    body: 'Holdover times vs. AC 91-74B — add a slide to syllabus lesson 7. Mention the difference between known vs. forecast icing.',
    linked_ac: '91-74B',
    updated_at: new Date(Date.now() - 432_000_000).toISOString(),
  },
  {
    id: 'seed-3',
    title: 'DPE question',
    body: 'Logging PIC vs. sole manipulator — re-check 61.51(e) before I answer the student. Bring up at next standardization meeting.',
    linked_ac: null,
    updated_at: new Date(Date.now() - 604_800_000).toISOString(),
  },
  {
    id: 'seed-4',
    title: 'Reg change to watch',
    body: "FAA fatigue rule changes for Part 135 operations — check if our pilot schedules need updating. Follow up after the new guidance has been in effect 90 days.",
    linked_ac: null,
    updated_at: new Date(Date.now() - 1_209_600_000).toISOString(),
  },
]

export function makeNoteId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export async function getNotes(): Promise<Note[]> {
  try {
    const raw = await AsyncStorage.getItem(NOTES_KEY)
    if (raw) return JSON.parse(raw)
    await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(SEED_NOTES))
    return SEED_NOTES
  } catch {
    return []
  }
}

export async function saveNotes(notes: Note[]): Promise<void> {
  await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(notes))
}
