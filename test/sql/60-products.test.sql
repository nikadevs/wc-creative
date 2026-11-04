-- The products table: seeded once, unique names, team members can edit.
do $$
begin
  assert (select count(*) from public.products where name in ('Neck Pillow', 'Air Cushion Back', 'Anti Theft Bag', 'GPS Wallet Tracker')) = 4, 'the four products are seeded';
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
insert into public.products (name, sort) values ('Test Product', 9);
update public.products set name = 'Test Product 2' where name = 'Test Product';
do $$
begin
  assert (select count(*) from public.products where name = 'Test Product 2') = 1, 'a member can add and rename';
  begin
    insert into public.products (name) values ('Neck Pillow');
    assert false, 'duplicate name must fail';
  exception when unique_violation then null;
  end;
end $$;
rollback;
