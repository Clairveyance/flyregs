-- Collapse internal runs of whitespace in AC titles -- 3 rows carried a
-- double space straight from the FAA source ("Initial Maintenance
-- Inspection  (IMI)..."), which surfaced verbatim in duel prompts (flagged
-- by game_scenarios_test.py's prompt-shape audit) and everywhere else the
-- title renders. FAR/AIM/P-CG measured clean.
update advisory_circulars
set title = regexp_replace(title, '\s+', ' ', 'g')
where title ~ '\s\s';
