-- ============================================================================
-- Mnemonic grouping  --  2026-08-02
--
-- RC, after pasting a large batch of new mnemonics organized into named
-- groups (Preflight Planning & Risk Management, VFR & Equipment
-- Requirements, IFR Flight Planning & En Route, etc.): "might be nice to
-- 'categorize' them, like what these lists do." A single flat MNEMONICS
-- list stops being useful past a handful of entries -- this is the column
-- the dictionary index groups by.
-- ============================================================================

alter table public.dictionary_terms add column if not exists mnemonic_group text;

-- Backfill for mnemonics reclassified BEFORE this column existed (PAVE,
-- IMSAFE in the first mnemonic-feature pass; AVE-F/MEA alongside it) --
-- sync/add_mnemonics_batch.py's 31-entry batch sets mnemonic_group directly
-- on insert, so only these 4 pre-existing rows need a manual backfill.
-- Caught live: these initially rendered under "Other" in the grouped
-- Mnemonics card until this backfill ran.
update public.dictionary_terms set mnemonic_group = 'Preflight Planning & Risk Management'
  where slug in ('rm_glossary-pave', 'rm_glossary-imsafe');

update public.dictionary_terms set mnemonic_group = 'IFR Flight Planning & En Route'
  where slug in ('mnem-ave-f', 'mnem-mea');
