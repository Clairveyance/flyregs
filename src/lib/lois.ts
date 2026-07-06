import { supabase } from '@/lib/supabase'
import { LetterOfInterpretation } from '@/types'

export async function getLOIsForAC(acId: string): Promise<LetterOfInterpretation[]> {
  try {
    const { data, error } = await supabase
      .from('loi_ac_references')
      .select('relevance, letters_of_interpretation(*)')
      .eq('ac_id', acId)
      .eq('letters_of_interpretation.status', 'active')
      .order('relevance')  // 'primary' sorts before 'related' alphabetically

    if (error || !data) return []

    return data
      .map((row: any) => row.letters_of_interpretation)
      .filter(Boolean) as LetterOfInterpretation[]
  } catch {
    return []
  }
}
