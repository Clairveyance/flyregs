-- ============================================================================
-- Mnemonic content corrections, round 2 -- 2026-08-02
--
-- 1. 5 Ps: RC asked whether each letter should get a description, like every
--    other entry has. Added.
-- 2. ARROW: RC caught that "W" (Weight and balance data) isn't actually
--    listed in FAR 91.203's required-onboard-documents list the way
--    Airworthiness certificate/Registration are -- verified against
--    FlyRegs' own FAR corpus: 91.203 lists only the airworthiness
--    certificate and registration certificate. W&B is aboard only
--    indirectly, as part of the approved AFM/POH that 91.9 requires be
--    available in the aircraft. Added an honest caveat on that one item
--    rather than silently overstating a direct requirement that doesn't
--    exist, or dropping W&B from the mnemonic (it's still the correct
--    letter -- ARROW is unchanged as a memory aid).
-- ============================================================================

update public.dictionary_terms
set senses = '[{
  "usage": null,
  "definition": "Single-pilot resource management intervals -- checked at multiple points before and during a flight.",
  "breakdown": [
    {"letter": "P", "concept": "Pilot", "detail": "fit to fly -- certificates, currency, personal readiness (IMSAFE)"},
    {"letter": "P", "concept": "Plane", "detail": "airworthy, equipped, and fueled for this flight"},
    {"letter": "P", "concept": "Plan", "detail": "route, altitude, and weather still match the briefing"},
    {"letter": "P", "concept": "Programming", "detail": "avionics/GPS/autopilot set correctly for the current phase"},
    {"letter": "P", "concept": "Passengers", "detail": "briefed, comfortable, and accounted for"}
  ]
}]'::jsonb
where slug = 'mnem-5-ps';

update public.dictionary_terms
set senses = '[{
  "usage": null,
  "definition": "Required aircraft documents that must be aboard.",
  "breakdown": [
    {"letter": "A", "concept": "Airworthiness certificate", "detail": ""},
    {"letter": "R", "concept": "Registration", "detail": ""},
    {"letter": "R", "concept": "Radio station license", "detail": "if operating internationally"},
    {"letter": "O", "concept": "Operating limitations/POH", "detail": ""},
    {"letter": "W", "concept": "Weight and balance data", "detail": "not itself listed in § 91.203 -- aboard only indirectly, as part of the approved AFM/POH § 91.9 requires"}
  ]
}]'::jsonb
where slug = 'mnem-arrow';
