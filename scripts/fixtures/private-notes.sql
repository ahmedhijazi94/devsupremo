
create table public.private_notes (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 body text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index private_notes_user_id_idx on public.private_notes(user_id);
alter table public.private_notes enable row level security;
grant select, insert, update, delete on public.private_notes to authenticated;
create policy notes_select on public.private_notes for select to authenticated using (auth.uid() = user_id);
create policy notes_insert on public.private_notes for insert to authenticated with check (auth.uid() = user_id);
create policy notes_update on public.private_notes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy notes_delete on public.private_notes for delete to authenticated using (auth.uid() = user_id);
