-- ============================================================================
-- Reg mnemonics: dictionary entries + isolated per-paragraph highlight anchors
--                                                                  2026-08-02
--
-- RC, from an annotated FAR 91.185 screenshot: pilots use "AVE-F" to
-- remember the four lost-comm route options, and "MEA" for the three
-- altitude options in the same section -- would be great to brighten those
-- specific words in the existing text (never alter the reg's own wording)
-- and make the monikers themselves findable in the Aviation Dictionary.
--
-- The critical constraint, RC's own: "MEA" ALREADY exists in
-- dictionary_terms as the real ICAO term "minimum en route altitude" --
-- an unrelated, much more common meaning that appears constantly across
-- IFR-related AIM/FAR content. The mnemonic sense of "MEA" must be
-- "isolated" -- discoverable as its own dictionary entry, but never
-- confused with, and never driving highlighting of, the real term.
--
-- Two separate mechanisms, deliberately not one:
--   1. dictionary_terms gets a new category='mnemonic' -- makes AVE-F/MEA
--      (mnemonic sense) independently findable/browsable, same as any
--      other dictionary entry, alongside (never merged with) the existing
--      MEA row.
--   2. reg_mnemonic_anchors is a SEPARATE table, one row per exact text
--      span to highlight, scoped to a specific (doc_type, doc_key) --
--      never a blind corpus-wide term match. This is what
--      PlainTextBody.tsx actually reads at render time; it never queries
--      dictionary_terms. A mnemonic dictionary entry existing does NOT by
--      itself cause any highlighting anywhere -- the two are linked only
--      by a human (or LLM, checked against real text) explicitly curating
--      an anchor row, the same "authored, not auto-derived" discipline
--      already used for study_facts.
-- ============================================================================

alter table public.dictionary_terms drop constraint if exists dictionary_terms_category_check;
alter table public.dictionary_terms add constraint dictionary_terms_category_check
  check (category in ('contraction', 'handbook', 'informal', 'mnemonic'));

create table if not exists public.reg_mnemonic_anchors (
  id            uuid primary key default gen_random_uuid(),
  mnemonic      text not null,             -- e.g. 'AVE-F'
  doc_type      text not null,             -- 'far' | 'aim' | ...
  doc_key       text not null,             -- e.g. '91.185', '5-4-9'
  letter        text not null,             -- which letter of the mnemonic this span is for, e.g. 'A'
  letter_order  smallint not null,         -- display/render order within the mnemonic
  -- The exact substring to brighten, verified against the real body_text
  -- at authoring time (scripts/verify_mnemonic_anchors.py). Render time
  -- does a plain .indexOf() for this exact string in the CURRENT
  -- body_text -- if the FAA revises the section and the string no longer
  -- matches, the anchor silently stops highlighting instead of lighting
  -- up the wrong text. No offsets stored: a stale offset into revised
  -- text would point at the wrong words with no way to detect it; a
  -- missing substring is at least detectable and fails safe.
  anchor_text   text not null,
  updated_at    timestamptz not null default now()
);

create index if not exists idx_reg_mnemonic_anchors_doc on public.reg_mnemonic_anchors (doc_type, doc_key);

alter table public.reg_mnemonic_anchors enable row level security;

create policy "reg_mnemonic_anchors public read" on public.reg_mnemonic_anchors
  for select using (true);

grant select on public.reg_mnemonic_anchors to anon, authenticated;
grant select, insert, update, delete on public.reg_mnemonic_anchors to service_role;
