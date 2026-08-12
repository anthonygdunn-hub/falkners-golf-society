-- Adds a group_type to groupings so the same table can hold both the
-- fours (the standard tee draw) and a separate pairs draw for the pairs
-- prize. Existing rows default to 'fours'. Safe to run twice.

alter table groupings
  add column if not exists group_type text not null default 'fours';

  do $$
  begin
    if not exists (
        select 1 from pg_constraint where conname = 'groupings_group_type_check'
          ) then
              alter table groupings
                    add constraint groupings_group_type_check
                          check (group_type in ('fours', 'pairs'));
                            end if;
                            end $$;
                            
