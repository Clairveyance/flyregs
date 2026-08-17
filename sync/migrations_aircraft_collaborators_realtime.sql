-- Same gap as folder_collaborators, found by tonight's My Fleet QA sweep
-- agent while re-testing the class of issue RC raised for folders:
-- my-aircraft/[id].tsx has ONLY useFocusEffect (screen-focus refresh) and no
-- AppState listener and no realtime subscription at all -- an owner who
-- shares an aircraft and stays on the screen never sees a collaborator's
-- acceptance, an access-level change, or a reminder/AD update land until
-- they navigate away and back. The screen's own comment already says this
-- plainly ("no refetch, no realtime subscription"). Same fix as
-- migrations_folder_collaborators_realtime.sql: add these 4 tables to the
-- realtime publication. RLS SELECT policies (checked first) already scope
-- delivery correctly -- owners_view_aircraft_collaborators /
-- users_view_own_aircraft_collaborations for aircraft_collaborators,
-- collaborators_view_shared_aircraft (has_aircraft_access) for the other 3
-- -- so no policy change needed, same as the folder case.
alter publication supabase_realtime add table aircraft_collaborators;
alter publication supabase_realtime add table user_aircraft;
alter publication supabase_realtime add table user_aircraft_equipment;
alter publication supabase_realtime add table user_aircraft_reminders;
