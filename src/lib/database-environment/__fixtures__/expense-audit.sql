-- Append-only history: written exclusively by the expense trigger, in the
-- same transaction. No expense FK: deletion must preserve its audit trail.
create table public.expense_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  expense_id uuid not null,
  action text not null check (action in ('created', 'updated', 'marked_paid', 'marked_pending', 'deleted')),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint expense_event_snapshots check (
    (action = 'created' and before_data is null and after_data is not null) or
    (action = 'deleted' and before_data is not null and after_data is null) or
    (action in ('updated', 'marked_paid', 'marked_pending') and before_data is not null and after_data is not null)
  )
);
create index expense_events_user_created_idx on public.expense_events(user_id, created_at desc);
create index expense_events_actor_idx on public.expense_events(actor_id);
create index expense_events_expense_created_idx on public.expense_events(expense_id, created_at desc);
alter table public.expense_events enable row level security;
create policy expense_events_select_own on public.expense_events for select to authenticated
  using (user_id = (select auth.uid()));
-- The invoker trigger can append only for its authenticated owner. Direct
-- REST/RPC inserts run at trigger depth zero and are rejected. Users cannot
-- install database triggers. UPDATE/DELETE have no policies, even for owners.
create policy expense_events_trigger_insert on public.expense_events for insert to authenticated
  with check (pg_trigger_depth() = 1 and user_id = (select auth.uid()) and actor_id = (select auth.uid()));

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create function private.record_expense_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  previous_data jsonb;
  next_data jsonb;
  event_action text;
begin
  if TG_OP <> 'INSERT' then
    previous_data := jsonb_build_object('description', OLD.description, 'amount_cents', OLD.amount_cents,
      'category', OLD.category, 'due_date', OLD.due_date, 'paid', OLD.paid);
  end if;
  if TG_OP <> 'DELETE' then
    next_data := jsonb_build_object('description', NEW.description, 'amount_cents', NEW.amount_cents,
      'category', NEW.category, 'due_date', NEW.due_date, 'paid', NEW.paid);
  end if;
  if TG_OP = 'UPDATE' and OLD.user_id is distinct from NEW.user_id then
    raise exception 'Expense ownership cannot be transferred' using errcode = '42501';
  end if;
  if TG_OP = 'UPDATE' and previous_data = next_data then
    return NEW;
  end if;
  -- Account deletion intentionally cascades its history as well. Avoid
  -- re-inserting history for an owner already deleted by that transaction.
  if TG_OP = 'DELETE' and pg_trigger_depth() > 1 then
    return OLD;
  end if;
  event_action := case
    when TG_OP = 'INSERT' then 'created'
    when TG_OP = 'DELETE' then 'deleted'
    when OLD.paid is distinct from NEW.paid then
      case when NEW.paid then 'marked_paid' else 'marked_pending' end
    else 'updated'
  end;
  insert into public.expense_events (user_id, actor_id, expense_id, action, before_data, after_data)
  values (
    case when TG_OP = 'DELETE' then OLD.user_id else NEW.user_id end,
    auth.uid(),
    case when TG_OP = 'DELETE' then OLD.id else NEW.id end,
    event_action, previous_data, next_data
  );
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
revoke all on function private.record_expense_event() from public, anon, authenticated;
create trigger expenses_record_history after insert or update or delete on public.expenses
  for each row execute function private.record_expense_event();
