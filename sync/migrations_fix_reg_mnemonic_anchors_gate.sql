-- Fixes P2-3 from the 2026-08-22 gating audit: reg_mnemonic_anchors
-- (every mnemonic AND its full letter-by-letter decomposition against the
-- reg text -- Mnemonics is a Pro feature) was world-readable, USING (true),
-- granted to anon. Confirmed live: anon key, no session, returns the full
-- mnemonic + letter breakdown. Every column on this table IS the gated
-- content (mnemonic/letter/anchor_text), unlike dictionary_terms (which
-- mixes public-safe metadata with gated senses, hence its own separate
-- dictionary_terms_gated view) -- gating the raw table's own RLS directly
-- is the right fix here, no view needed. Client already correctly gates
-- presenting this content on hasProAccess (src/app/dictionary/[slug].tsx),
-- so this is a server-side defense-in-depth fix, not a behavior change for
-- legitimate access.
drop policy if exists "reg_mnemonic_anchors public read" on public.reg_mnemonic_anchors;
create policy "reg_mnemonic_anchors public read" on public.reg_mnemonic_anchors
  for select
  using (has_pro_access());
