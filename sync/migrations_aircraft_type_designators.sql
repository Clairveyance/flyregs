-- ============================================================================
-- Aircraft type-designator catalog  --  2026-07-31
--
-- src/lib/aircraftModels.ts's AIRCRAFT_MODEL_ALIASES is explicitly a ~50-
-- entry curated SEED, not the real fleet -- its own comment flags the FAA's
-- Type Certificate Data Sheets as "a real sourcing project, logged as a
-- follow-up." This table is that follow-up's data half: the FAA's own
-- Releasable Aircraft Registry download (https://registry.faa.gov/database/
-- ReleasableAircraft.zip, refreshed daily, ~60-70MB, no auth) ships
-- ACFTREF.txt -- a reference file of every distinct aircraft manufacturer/
-- model/series combination the registry has ever recorded, used to resolve
-- the CODE on every individual N-number row in MASTER.txt. That MODEL field
-- IS the real FAA type-certificate designator string ("PA-28-181", "172S",
-- "36", "LA-4-200") -- confirmed by cross-checking known cases (Cessna
-- 172S, Piper PA-28-181, Beech 36, matches exactly) and by the field's own
-- description in the FAA's ardata.pdf ("Name of the aircraft model and
-- series").
--
-- Filtered to BUILD-CERT-IND = 0 (Type Certificated) only -- excludes
-- amateur-built (1) and Light Sport (2) rows, which don't carry a real FAA
-- type certificate and whose "model" field is often just a homebuilt
-- project's own name, not a designator ADs are ever filed against.
-- 9,229 distinct (manufacturer, type_designator) pairs after that filter
-- and de-duplication -- versus the ~50 in the hand-curated seed.
--
-- What this table does NOT solve: it has no marketing names ("Skyhawk",
-- "Warrior", "Bonanza") anywhere in it -- ACFTREF only records the
-- manufacturer's own technical designation, the same gap the curated seed
-- was built to cover. The two are complementary, not redundant:
-- AIRCRAFT_MODEL_ALIASES (marketing name -> designator, hand-curated) stays
-- as the first lookup; this table backs a real autocomplete/validation
-- layer once a designator is typed or suggested, and widens exact-match AD
-- coverage far beyond the curated seed's ~50 families. Extracting marketing
-- names at scale would mean OCR/LLM-reading ~2,000 individual TCDS PDFs off
-- FAA's DRS (itself already found to block bulk enumeration when LOIs were
-- scoped, see flyregs_loi_build_spec.md) -- a real paid-API cost, logged as
-- a follow-up rather than started without asking first, per the standing
-- "ask before spending on Vision/Console" rule.
-- ============================================================================

create table if not exists public.aircraft_type_designators (
  id                bigserial primary key,
  manufacturer      text not null,
  type_designator   text not null,
  -- Raw FAA single-char codes, kept as-is rather than expanded -- see
  -- ardata.pdf's own legend (1 Glider, 2 Balloon, 3 Blimp/Dirigible, 4 Fixed
  -- wing single engine, 5 Fixed wing multi engine, 6 Rotorcraft, 7 Weight-
  -- shift-control, 8 Powered Parachute, 9 Gyroplane, H Hybrid Lift, O
  -- Other) for type_acft; ac_cat is 1 Land, 2 Sea, 3 Amphibian.
  type_acft         text,
  ac_cat            text,
  num_engines       int,
  num_seats         int,
  -- Sparse -- confirmed live only a minority of rows (mostly balloons in a
  -- spot check) carry these; most GA singles/twins have them blank in the
  -- source file itself. Store when present rather than guess.
  tc_data_sheet     text,
  tc_data_holder    text,
  updated_at        timestamptz not null default now(),
  unique (manufacturer, type_designator)
);

create index if not exists aircraft_type_designators_designator_idx
  on public.aircraft_type_designators (type_designator);
create index if not exists aircraft_type_designators_mfr_idx
  on public.aircraft_type_designators (manufacturer);

grant select on public.aircraft_type_designators to anon, authenticated;

alter table public.aircraft_type_designators enable row level security;
drop policy if exists aircraft_type_designators_readable on public.aircraft_type_designators;
create policy aircraft_type_designators_readable on public.aircraft_type_designators
  for select using (true);
