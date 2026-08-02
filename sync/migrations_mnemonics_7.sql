-- ============================================================================
-- Fix DECR -> DELS -- 2026-08-02
--
-- RC: "where did DECR come from? I think we usually used DELS for Date
-- Error Location Signature." Verified against FlyRegs' own FAR 91.171
-- text: "shall enter the date, place, bearing error, and sign the
-- aircraft log" -- Date/Place(Location)/Error/Signature, matching DELS
-- exactly. DECR's "Checkpoint" and "Radio technician/Pilot signature"
-- don't match the actual regulatory language at all -- this was a real
-- fabrication, not a genuine alternate mnemonic worth keeping alongside
-- DELS. Replaced the row in place (slug changes mnem-decr -> mnem-dels;
-- safe, this content was only added earlier today, no real users have
-- bookmarked it yet).
-- ============================================================================

update public.dictionary_terms
set term = 'DELS', slug = 'mnem-dels',
    senses = '[{
      "usage": null,
      "definition": "Required VOR-check logbook entries (FAR 91.171): \"shall enter the date, place, bearing error, and sign the aircraft log.\"",
      "breakdown": [
        {"letter": "D", "concept": "Date", "detail": ""},
        {"letter": "E", "concept": "Error", "detail": "bearing error observed, in degrees"},
        {"letter": "L", "concept": "Location", "detail": "place the check was performed -- FAR 91.171''s own word is \"place\""},
        {"letter": "S", "concept": "Signature", "detail": "of the pilot (or repair station certificate holder/representative, if using a radiated test signal)"}
      ]
    }]'::jsonb
where slug = 'mnem-decr';
