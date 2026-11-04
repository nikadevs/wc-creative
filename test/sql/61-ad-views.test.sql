-- ad_views: one row per Library ID, digits only, shared by the team.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
insert into public.ad_views (library_id) values ('1234567890');
insert into public.ad_views (library_id) values ('1234567890') on conflict do nothing;
do $$
begin
  assert (select count(*) from public.ad_views where library_id = '1234567890') = 1, 'one row per ad';
  begin
    insert into public.ad_views (library_id) values ('abc');
    assert false, 'a non numeric id must fail';
  exception when check_violation then null;
  end;
end $$;
rollback;
