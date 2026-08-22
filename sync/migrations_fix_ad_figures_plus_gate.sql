-- Fixes P2-1 from the 2026-08-22 gating audit: ad_figures (full-page
-- renders of an AD's own source PDF) was fully public (USING (true)) --
-- readable and downloadable by anyone with just the anon key, no session
-- required -- while airworthiness_directives_gated correctly NULLs
-- body_text below Plus. Confirmed live: anon key, no session, real image
-- bytes back. Its sibling table ac_figures already gates correctly on
-- has_plus_access() -- this brings ad_figures in line with the exact
-- same pattern, closing the one table the earlier figures-tightening
-- sweep missed.
drop policy if exists public_read_ad_figures_rows on public.ad_figures;
create policy public_read_ad_figures_rows on public.ad_figures
  for select
  using (has_plus_access());
