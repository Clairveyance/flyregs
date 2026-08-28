// Turns a regulation passage into an actual QUESTION.
//
// The bug this fixes: Study Mode never generated a question at all. The card
// front was literally `shortenQuestion(definition)` — a truncated slab of the
// regulation itself — so a card read:
//
//   "(a) The applicant must design the airplane to— (1) Allow clear
//    communication between the flightcrew and passengers; (2) Protect the
//    pilot and flight controls from…"
//
// That is not a question, there is nothing to answer, and flipping it just
// shows more of the same text. Rejected on sight, correctly.
//
// Regulatory prose is highly formulaic, which is what makes deterministic
// question generation viable here. Each rule below keys off a sentence
// pattern the FAA uses constantly, and rewrites it into the question whose
// answer is the passage. Order matters: the most specific pattern that
// matches wins, and `fallback` guarantees we never render a bare passage
// again.

export type QuizSourceType = 'pcg' | 'far' | 'aim' | 'ac' | 'ad' | 'loi' | 'dictionary' | 'cfr49'

export interface QuizSource {
  type: QuizSourceType
  /** "§ 91.3", "4-3-13", "AC 91-73" — used to anchor the question. */
  documentNumber: string
  /** Section/paragraph title, when the type has one. */
  title?: string | null
  /** The passage being tested (P/CG definition, or FAR/AIM body text). */
  text: string
}


/** First sentence of a definition, hard-capped at a word boundary.
 * Client-side mirror of the DB's quiz_prompt_condense() (see
 * sync/migrations_pcg_prompt.sql): the P/CG writes the defining clause
 * first, so the opening sentence is both the shortest and the most
 * identifying part. Card faces must never be a wall of text. */
export function condenseDefinition(text: string, max = 180): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return t
  const m = t.match(/^(.{20,}?\.)(?:\s|$)/)
  const first = m ? m[1] : t
  if (first.length <= max) return first.trim()
  const head = first.slice(0, max)
  const cut = head.lastIndexOf(' ')
  return (cut >= 20 ? head.slice(0, cut) : head).trim() + '\u2026'
}

/** Trailing "—", ":" and citation cruft that reads badly mid-question. */
function tidy(s: string): string {
  const t = s
    .replace(/\s+/g, ' ')
    .replace(/[—–-]\s*$/, '')
    .replace(/[:;,]\s*$/, '')
    .trim()
  // Strip a trailing FULL STOP as well. 4,071 of 4,272 FAR titles (95%) end
  // in one, so without this nearly every FAR question rendered
  // "...reply or request for hearing.?" -- seen live in Study Mode.
  // A dotted abbreviation keeps its period: ".X." at the end means "U.S."
  // (3 sections end that way), whereas an acronym closing a sentence
  // ("...protection of EWIS.") has no preceding dot and is safe to strip.
  return /\.[A-Z]\.$/.test(t) ? t : t.replace(/\.$/, '')
}

/** True when a title is ALREADY phrased as a question.
 *
 * 94 FAR sections are written this way ("How much time do I have to submit
 * comments to FAA on a petition for exemption?"). Wrapping those in
 * "What does § X say about ...?" produced a double question mark and a
 * sentence nobody would ever say out loud. */
function isQuestionTitle(s: string): boolean {
  return /\?\s*$/.test(s.trim())
}

/** Trims a section title down to a topic short enough to read like a quiz
 * prompt rather than a citation.
 *
 * Measured before this existed: 31% of generated questions ran over 80
 * characters, 11% over 110, and the longest was 316 — because FAA titles
 * carry their full scope after a colon or semicolon
 * ("Civil penalties: Administrative assessment against a person other than
 * an individual acting as a pilot, flight engineer, mechanic, or
 * repairman; administrative assessment against all persons for hazardous
 * materials violations"). The lead-in before the punctuation is the actual
 * subject; everything after it is qualification. 537 FAR titles carry a
 * colon and 45 a semicolon. */
const TOPIC_MAX = 64

/** Drops a parenthetical that the cut left hanging open.
 *
 * Seen live on an AC card: "Ratings and Operating Limitations for Turbine
 * Engines (Sections?" — the truncation landed inside "(Sections 33.7...)"
 * and left an unclosed bracket staring at the player. */
function closeParens(t: string): string {
  const opens = (t.match(/\(/g) ?? []).length
  const closes = (t.match(/\)/g) ?? []).length
  if (opens <= closes) return t
  const at = t.lastIndexOf('(')
  return at > 0 ? tidy(t.slice(0, at)) : t
}

function shortTopic(s: string): string {
  const t = tidy(s)
  if (t.length <= TOPIC_MAX) return t
  // Prefer the subject before a colon/semicolon, but only if that leaves
  // something substantial -- "Scope: ..." would otherwise reduce to "Scope".
  for (const sep of [':', ';']) {
    const i = t.indexOf(sep)
    if (i >= 12 && i <= TOPIC_MAX) return closeParens(tidy(t.slice(0, i)))
  }
  // Otherwise cut at the last word boundary that fits, preferring a comma.
  const head = t.slice(0, TOPIC_MAX)
  const comma = head.lastIndexOf(',')
  if (comma >= 20) return closeParens(tidy(head.slice(0, comma)))
  const space = head.lastIndexOf(' ')
  return closeParens(tidy(space >= 20 ? head.slice(0, space) : head))
}

/** Lowercases a fragment for mid-sentence use without wrecking §, acronyms,
 * or proper nouns (ATC, IFR, FAA all stay upper). */
function midSentence(s: string): string {
  const t = tidy(s)
  // Leave acronyms (ATC, IFR) alone.
  if (/^[A-Z]{2,}\b/.test(t)) return t
  // Leave Title Case titles alone too. Lowercasing only the first character
  // of "Airspace Restrictions To Flight" produced "airspace Restrictions To
  // Flight", which reads as a typo. A title with 2+ capitalised words is a
  // proper name for a section and should keep its own casing.
  const capWords = (t.match(/\b[A-Z][a-z]+/g) ?? []).length
  if (capWords >= 2) return t
  return t.charAt(0).toLowerCase() + t.slice(1)
}

/** A short, human label for the document the question is anchored to. */
function anchor(src: QuizSource): string {
  switch (src.type) {
    // "14 CFR § 91.103" -> "§ 91.103". The card already carries a FAR type
    // badge, so the "14 CFR" prefix was 7 redundant characters on every one
    // of ~4,100 FAR questions, in a prompt meant to read like a game show.
    case 'far':
      return src.documentNumber.startsWith('§') ? src.documentNumber : `§ ${src.documentNumber}`
    case 'aim':
      return `AIM ${src.documentNumber}`
    case 'ac':
      return `AC ${src.documentNumber.replace(/^AC\s*/i, '')}`
    case 'ad':
      return `AD ${src.documentNumber.replace(/^AD\s*/i, '')}`
    default:
      return src.documentNumber
  }
}

/** Strips list scaffolding ("(a)", "(1)") that starts a passage — it is
 * structure, not content, and makes every question start the same way. */
function stripLeadMarkers(text: string): string {
  return text.replace(/^\s*(\([a-z0-9ivx]{1,4}\)\s*)+/i, '').trim()
}

/** First sentence, which is where the rule almost always lives. */
function firstSentence(text: string): string {
  const t = stripLeadMarkers(text)
  const m = t.match(/^(.{15,240}?[.!?])(\s|$)/)
  return tidy(m ? m[1] : t.slice(0, 240))
}

type Rule = { test: RegExp; build: (m: RegExpMatchArray, src: QuizSource) => string | null }

const RULES: Rule[] = [
  // "X means Y" / "X refers to Y" — the P/CG's whole shape, and common in
  // FAR definitions sections.
  {
    test: /^(.{2,80}?)\s+(?:means|refers to|is defined as)\b/i,
    // The captured subject must actually be a NOUN PHRASE. Without this,
    // "...the certificate holder must provide and use means of..." matched
    // on the noun "means" and produced "What is the certificate holder must
    // provide and use?". A subject containing a modal is a sentence, not a
    // term being defined — fall through to a later rule instead.
    build: (m) => (/\b(must|shall|may|will)\b/i.test(m[1]) ? null : `What is ${midSentence(m[1])}?`),
  },
  // "No person may X unless/until Y" — the classic FAA prohibition.
  {
    test: /\bno person may\s+(.{5,120}?)\s+(?:unless|until|except)\b/i,
    build: (m, src) => `Under ${anchor(src)}, when may a person ${midSentence(m[1])}?`,
  },
  // "No person may X." — prohibition with no condition attached.
  {
    test: /\bno person may\s+(.{5,120}?)[.;]/i,
    build: (m, src) => `What does ${anchor(src)} prohibit regarding ${midSentence(m[1])}?`,
  },
  // The SAME prohibition with a subject other than "person" — "No program
  // manager or owner may use a pilot unless...", "No certificate holder
  // may...". 240 FAR sections are written this way and none of them matched
  // the two rules above, so they fell through to weaker ones. Seen live:
  // "No program manager or owner may use a pilot..." reached the permissive
  // "may use" rule below and rendered as "Under § 91.1065, when may a pilot
  // use?" — a broken sentence that also inverted subject and object.
  // Both branches must come BEFORE the permission rule for that reason.
  {
    test: /\bno\s+([a-z][a-z ]{2,34}?)\s+may\s+(.{5,100}?)\s+(?:unless|until|except)\b/i,
    build: (m, src) => `Under ${anchor(src)}, when may a ${midSentence(m[1])} ${midSentence(m[2])}?`,
  },
  {
    test: /\bno\s+([a-z][a-z ]{2,34}?)\s+may\s+(.{5,100}?)[.;]/i,
    build: (m, src) => `What does ${anchor(src)} prohibit a ${midSentence(m[1])} from doing?`,
  },
  // "The pilot in command / Each holder ... is responsible for / has authority"
  {
    test: /\b(the pilot in command|each \w+(?: \w+)?|the \w+ pilot)\b[^.]{0,40}\b(?:is|are|shall be)\s+(?:directly\s+)?responsible\b/i,
    build: (_m, src) => `Under ${anchor(src)}, who is responsible, and for what?`,
  },
  // Numeric requirement — hours, days, feet, knots. Ask for the number.
  {
    test: /\b(?:at least|no less than|a minimum of|not more than|no later than)\s+([\d,]+(?:\.\d+)?)\s+(hours?|days?|months?|years?|feet|ft|nautical miles|miles|knots|minutes?)\b/i,
    build: (m, src) => `How many ${m[2].toLowerCase()} does ${anchor(src)} require?`,
  },
  // "This part/section prescribes|contains|establishes ..." — a scope
  // statement. 10% of FAR sections open this way, and asking what the section
  // COVERS is the natural question for them.
  {
    test: /\bthis (?:part|section|subpart|chapter)\s+(?:prescribes|contains|establishes|describes|sets forth|provides)\b/i,
    build: (_m, src) => `What does ${anchor(src)} cover?`,
  },
  // "... applies to X" — applicability. Ask WHO/WHAT it binds.
  {
    test: /\bapplies to\b/i,
    build: (_m, src) => `Who or what does ${anchor(src)} apply to?`,
  },
  // "may not ..." — prohibition phrased permissively.
  {
    test: /\bmay not\s+(.{4,100}?)[.;,]/i,
    // Needs a real verb PHRASE, not a lone transitive verb: "...may not
    // conduct, ..." produced "what may not conduct?". Require at least two
    // words so there is an object or complement to ask about.
    build: (m, src) =>
      tidy(m[1]).split(/\s+/).length < 2
        ? null
        : `Under ${anchor(src)}, what may not ${midSentence(m[1])}?`,
  },
  // "Each person/holder/applicant/operator ... must|shall ..." — the duty is
  // on a named party, so name them in the question.
  {
    test: /\beach\s+(person|holder|applicant|operator|certificate holder|pilot|owner)\b[^.]{0,60}?\b(?:must|shall)\b/i,
    build: (m, src) => `Under ${anchor(src)}, what must each ${m[1].toLowerCase()} do?`,
  },
  // "must|shall <any verb>" — the general requirement. Deliberately LAST of
  // the requirement family so the more specific rules above win. Widened from
  // an explicit verb list (be|have|include|contain|provide|maintain) which
  // matched only 24% of sections; "must" + an arbitrary verb accounts for a
  // further 27%.
  {
    test: /\b(?:must|shall)\s+\w+/i,
    build: (_m, src) =>
      src.title ? `What does ${anchor(src)} require for ${midSentence(shortTopic(src.title))}?` : `What does ${anchor(src)} require?`,
  },
  // "The applicant must design/show/demonstrate ..." — certification rules.
  {
    test: /\bthe applicant must\s+(.{4,90}?)[.;,]/i,
    build: (m, src) => `Under ${anchor(src)}, what must the applicant ${midSentence(m[1])}?`,
  },
  // "may deviate / may exceed ... if" — permission with a condition.
  // INTRANSITIVE verbs only. "use" and "conduct" need an object, so
  // "...may use a pilot" became "when may a pilot use?" — broken, and with
  // the object promoted to subject. Those readings are prohibitions anyway
  // and are now caught by the "no <subject> may" rules above.
  {
    test: /\bmay\s+(deviate|exceed)\b/i,
    build: (m, src) => `Under ${anchor(src)}, when may a pilot ${m[1].toLowerCase()}?`,
  },
]

/**
 * Builds a short, direct question whose answer is the passage.
 * Never returns the passage itself.
 */
export function buildQuizQuestion(src: QuizSource): string {
  // A P/CG entry already has the cleanest possible question: its own term.
  if (src.type === 'pcg') {
    const term = tidy(src.documentNumber || src.title || '')
    if (term) return `What is ${term}?`
  }

  // An AC's only body text IS its title, so anchoring the question to the
  // document number produced a tautology -- seen live in Study Mode:
  //   Q: "What does AC 25.1329-1C say about Approval of Flight Guidance
  //       Systems, Including Change 2?"
  //   A: "Approval of Flight Guidance Systems, Including Change 2"
  // The answer was the question. The document number is the thing worth
  // recalling, which is exactly the shape a Duel already uses for ACs
  // (prompt = title, choices = AC numbers).
  if (src.type === 'ac' && src.title && tidy(src.title).length > 3) {
    return `Which AC covers ${midSentence(shortTopic(src.title))}?`
  }

  // A title that is already a question IS the question. 94 FAR sections are
  // written this way, and wrapping them produced "...for exemption??".
  if (src.title && isQuestionTitle(src.title)) {
    const asked = src.title.trim()
    return `${anchor(src)} — ${asked.charAt(0).toUpperCase()}${asked.slice(1)}`
  }

  const sentence = firstSentence(src.text)
  for (const rule of RULES) {
    const m = sentence.match(rule.test)
    if (m) {
      const q = rule.build(m, src)
      // 160 was far too generous for something meant to read like a game
      // show prompt; the p90 was 113 characters. Rules that blow past 120
      // now fall through to the shorter title-based question instead.
      if (q && q.length <= 120) return q
    }
  }

  // Fallback: still a real question, anchored to the document's own topic —
  // never a raw slab of the regulation.
  if (src.title && tidy(src.title).length > 3) {
    return `What does ${anchor(src)} say about ${midSentence(shortTopic(src.title))}?`
  }
  return `What does ${anchor(src)} require?`
}

// ---------------------------------------------------------------------------
// STUDY CARD FACES — the flashcard contract, set explicitly by RC 2026-07-31:
//   "The Q has to be one short, single sentence or phrase. The A should just
//    be a reg name or number. It's that simple."
// The previous card back was the raw regulation body (a slab of "(a) The
// applicant must design the airplane to— (1)..." — rejected on sight), and
// the front leaned on body-pattern rules that produced trivia like "What
// does § 23.2320 require for occupant physical environment?".
//
// New model, identical in spirit to what Duels already do:
//   FAR   Q "Which Part 23 rule covers occupant physical environment?"
//         A "FAR § 23.2320"
//   AIM   Q "Which AIM paragraph covers Traffic Control Light Signals?"
//         A "AIM 4-3-13"
//   AC    Q "Which AC covers Airport Emergency Plan?"    A "AC 150/5200-31C"
//   P/CG  Q "What is MINIMUM FUEL?"                      A first-sentence def
// Reverse direction flips it (front "FAR § 23.2320" → back the title), so
// BOTH directions are short. No face ever shows body text.
//
// The FAR question names its Part on purpose: 45% of FAR sections share a
// bare title with another section ("Applicability." ×181 — see the D7 duel
// work), and "Which rule covers applicability?" would have 181 right
// answers. Within one Part it is almost always unique. AIM appends its
// chapter for the same reason when the title is a known-generic short one
// ("General" ×15).
// ---------------------------------------------------------------------------
export interface StudyCardFaces {
  /** defFirst direction: the question asked. */
  question: string
  /** defFirst direction: the short answer revealed. */
  answer: string
  /** reverse direction: the identifier shown first. */
  reverseFront: string
  /** reverse direction: what the user is recalling. */
  reverseBack: string
}

export function buildStudyCard(src: QuizSource): StudyCardFaces {
  const num = src.documentNumber
  const title = tidy(src.title ?? '')
  switch (src.type) {
    case 'pcg': {
      const term = num || title
      const def = condenseDefinition(src.text)
      return {
        question: `What is ${term}?`,
        answer: def,
        reverseFront: def,
        reverseBack: term,
      }
    }
    // Dictionary terms are structurally identical to P/CG here -- a
    // term+definition pair with nothing else to cite -- but unlike
    // pcg_terms.term (always shouting-case, "CLEARED AS FILED"),
    // dictionary_terms.term is already correctly cased in the source data
    // ("COMBATS" is meant to stay all-caps as a real acronym; "5 Ps" is
    // already natural) -- no toTitleCase() equivalent needed or wanted.
    case 'dictionary': {
      const term = num || title
      const def = condenseDefinition(src.text)
      return {
        question: `What is ${term}?`,
        answer: def,
        reverseFront: def,
        reverseBack: term,
      }
    }
    case 'far': {
      const part = num.replace(/^§\s*/, '').split('.')[0]
      const label = `FAR ${num.startsWith('§') ? num : `§ ${num}`}`
      // 94 FAR titles are already questions ("How much time do I have to
      // submit comments...?") — use them verbatim; they're the best Q text
      // the FAA ever wrote.
      const q = isQuestionTitle(src.title ?? '')
        ? (src.title ?? '').trim()
        : `Which Part ${part} rule covers ${midSentence(shortTopic(title))}?`
      return { question: q, answer: label, reverseFront: label, reverseBack: title }
    }
    // Same shape as 'far' -- "Which 49 CFR Part N rule..." rather than
    // "Which Part N rule..." specifically so it can't be misread as a
    // 14 CFR (FAR) citation, since a bare part number alone doesn't
    // disambiguate the two title systems.
    case 'cfr49': {
      const part = num.replace(/^§\s*/, '').split('.')[0]
      const label = `49 CFR ${num.startsWith('§') ? num : `§ ${num}`}`
      const q = isQuestionTitle(src.title ?? '')
        ? (src.title ?? '').trim()
        : `Which 49 CFR Part ${part} rule covers ${midSentence(shortTopic(title))}?`
      return { question: q, answer: label, reverseFront: label, reverseBack: title }
    }
    case 'aim': {
      const chapter = num.split('-')[0]
      const generic = title.length <= 14
      const q = `Which AIM paragraph covers ${midSentence(shortTopic(title))}?` +
        (generic && /^\d+$/.test(chapter) ? ` (Chapter ${chapter})` : '')
      const label = `AIM ${num}`
      return { question: q, answer: label, reverseFront: label, reverseBack: title }
    }
    default: {
      // ac (and any future doc type with a number+title shape). Start
      // simple, per RC (2026-07-31): Q is the AC's OWN title VERBATIM (not
      // paraphrased into "Which AC covers ..."), A is just the number --
      // e.g. Q "Certification: Pilots and Flight and Ground Instructors"
      // A "AC 61-65". This is the reference-recall version; a harder,
      // body-derived version ("What AC do you use to find sample
      // endorsements?") needs real content extraction from the AC's body
      // the parser doesn't reliably support yet, and comes later.
      const label = `AC ${num.replace(/^AC\s*/i, '')}`
      return {
        question: title || `What does ${label} cover?`,
        answer: label,
        reverseFront: label,
        reverseBack: title,
      }
    }
  }
}
