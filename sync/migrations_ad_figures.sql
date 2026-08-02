-- ============================================================================
-- ad_figures -- 2026-08-02
--
-- RC: "let's work the entire AD T&F build." Corpus scan found 536 ADs
-- (10.7%) mention "Table N", 487 (9.7%) mention "Figure N", and 411 (8.2%)
-- contain literal [GRAPHIC] placeholders -- embedded images the text-only
-- pipeline never extracted. No ad_figures table existed at all before this.
--
-- Design: unlike AIM's single giant combined PDF (where matching a figure
-- mention to the right page needs real resolution logic -- see
-- backfill_aim_pdf_images.py), each AD is its own short (2-10 page),
-- self-contained PDF. So there's no need to precisely locate which page
-- has the table/graphic -- render every page of a candidate AD's PDF and
-- let the user page through the (short) document as images, same
-- "Figures & Tables" browsing pattern AC/AIM already use, just without
-- AC's per-figure label/caption metadata (ADs' figures are almost never
-- individually captioned in the source text the way AC/AIM figures are).
--
-- Grants mirror ac_figures/aim_figures exactly: no RLS on either (relies
-- on GRANT-level permissions instead) -- public read-only, service_role
-- for writes. This project got bitten twice this session by a NEW content
-- type missing from an existing table's permissions/constraints (see
-- gotcha_synced_folder_items_check_constraint.md) -- matching the
-- established pattern exactly here, not inventing a new one.
-- ============================================================================

create table if not exists public.ad_figures (
  id uuid primary key default gen_random_uuid(),
  ad_number text not null references public.airworthiness_directives(ad_number) on delete cascade,
  page_index int not null,
  image_url text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (ad_number, page_index)
);

create index if not exists ad_figures_ad_number_idx on public.ad_figures (ad_number);

revoke all on public.ad_figures from public;
grant select on public.ad_figures to anon, authenticated;
grant select, insert, update, delete on public.ad_figures to service_role;

-- RLS is enabled by default on new tables in this project (the earlier
-- grants-lockdown pass, see migrations_grants_lockdown.sql) -- found live:
-- ac_figures/aim_figures both need an explicit permissive public-read
-- POLICY on top of the GRANT above, not just the grant alone, or anon/
-- authenticated get zero rows despite having SELECT granted (RLS enabled
-- + zero policies = deny-all for non-bypass roles). Missed this the first
-- time; caught immediately by testing a real anon-key read before scaling
-- to the full batch, not just trusting the service-role write succeeding.
alter table public.ad_figures enable row level security;
create policy "public_read_ad_figures_rows" on public.ad_figures
  for select to public using (true);
