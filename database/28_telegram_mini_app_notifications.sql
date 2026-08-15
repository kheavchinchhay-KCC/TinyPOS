-- ============================================================================
-- Tiny POS - Step 31: Telegram Mini App and relevant-user notifications
-- Run once in the NEW Supabase project after Step 30.
--
-- Security model:
--   * A POS user links exactly one Telegram account.
--   * A Telegram account can link to only one POS user in an organization.
--   * Browser linking uses a short-lived one-time code.
--   * Mini App linking validates Telegram initData in a Netlify Function.
--   * Notification routing uses active user, branch, role and personal settings.
--
-- Telegram bot tokens and webhook secrets stay in Netlify environment variables.
-- They are never stored in this database or exposed to the frontend.
-- ============================================================================

begin;

create table if not exists public.telegram_user_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  telegram_user_id bigint not null,
  chat_id bigint not null,
  username text,
  first_name text,
  last_name text,
  language_code text,
  is_active boolean not null default true,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id),
  unique (organization_id, telegram_user_id)
);

create index if not exists telegram_user_links_chat_idx
  on public.telegram_user_links (chat_id)
  where is_active = true;

create table if not exists public.telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists telegram_link_codes_user_expiry_idx
  on public.telegram_link_codes (user_id, expires_at desc);

create table if not exists public.telegram_notification_preferences (
  user_id uuid primary key
    references public.profiles(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  stock_alerts boolean not null default true,
  sales_summary boolean not null default true,
  credit_alerts boolean not null default true,
  supplier_alerts boolean not null default true,
  purchase_alerts boolean not null default true,
  transfer_alerts boolean not null default true,
  quotation_alerts boolean not null default true,
  cash_register_alerts boolean not null default true,
  system_alerts boolean not null default true,

  all_branches boolean not null default false,
  daily_summary_hour integer not null default 18
    check (daily_summary_hour between 0 and 23),
  quiet_start_hour integer
    check (quiet_start_hour is null or quiet_start_hour between 0 and 23),
  quiet_end_hour integer
    check (quiet_end_hour is null or quiet_end_hour between 0 and 23),

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.telegram_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  telegram_link_id uuid
    references public.telegram_user_links(id) on delete set null,
  event_type text not null,
  event_key text not null,
  chat_id bigint not null,
  message_text text not null,
  status text not null default 'pending'
    check (status in ('pending','sent','failed','skipped')),
  telegram_message_id bigint,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, event_key)
);

create index if not exists telegram_deliveries_user_date_idx
  on public.telegram_notification_deliveries (
    user_id,
    created_at desc
  );

-- Common updated_at trigger already exists in Tiny POS.
drop trigger if exists set_telegram_user_links_updated_at
  on public.telegram_user_links;
create trigger set_telegram_user_links_updated_at
before update on public.telegram_user_links
for each row execute function public.set_updated_at();

drop trigger if exists set_telegram_preferences_updated_at
  on public.telegram_notification_preferences;
create trigger set_telegram_preferences_updated_at
before update on public.telegram_notification_preferences
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Default notification settings by role
-- ----------------------------------------------------------------------------

create or replace function private.ensure_telegram_preferences(
  p_user_id uuid
)
returns public.telegram_notification_preferences
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_result public.telegram_notification_preferences%rowtype;
begin
  select * into v_profile
  from public.profiles
  where id = p_user_id;

  if not found then
    raise exception 'POS profile not found';
  end if;

  insert into public.telegram_notification_preferences (
    user_id,
    organization_id,
    stock_alerts,
    sales_summary,
    credit_alerts,
    supplier_alerts,
    purchase_alerts,
    transfer_alerts,
    quotation_alerts,
    cash_register_alerts,
    system_alerts,
    daily_summary_hour
  )
  values (
    v_profile.id,
    v_profile.organization_id,
    v_profile.role in ('owner','admin','manager'),
    true,
    v_profile.role in ('owner','admin','manager'),
    v_profile.role in ('owner','admin','manager'),
    v_profile.role in ('owner','admin','manager'),
    v_profile.role in ('owner','admin','manager'),
    v_profile.role in ('owner','admin','manager','cashier'),
    v_profile.role in ('owner','admin','manager','cashier'),
    v_profile.role in ('owner','admin'),
    18
  )
  on conflict (user_id) do nothing;

  select * into v_result
  from public.telegram_notification_preferences
  where user_id = p_user_id;

  return v_result;
end;
$$;

revoke all on function private.ensure_telegram_preferences(uuid)
  from public;
grant execute on function private.ensure_telegram_preferences(uuid)
  to authenticated, service_role;

insert into public.telegram_notification_preferences (
  user_id,
  organization_id,
  stock_alerts,
  sales_summary,
  credit_alerts,
  supplier_alerts,
  purchase_alerts,
  transfer_alerts,
  quotation_alerts,
  cash_register_alerts,
  system_alerts,
  daily_summary_hour
)
select
  profile_row.id,
  profile_row.organization_id,
  profile_row.role in ('owner','admin','manager'),
  true,
  profile_row.role in ('owner','admin','manager'),
  profile_row.role in ('owner','admin','manager'),
  profile_row.role in ('owner','admin','manager'),
  profile_row.role in ('owner','admin','manager'),
  profile_row.role in ('owner','admin','manager','cashier'),
  profile_row.role in ('owner','admin','manager','cashier'),
  profile_row.role in ('owner','admin'),
  18
from public.profiles profile_row
on conflict (user_id) do nothing;

create or replace function private.create_telegram_preferences_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.ensure_telegram_preferences(new.id);
  return new;
end;
$$;

drop trigger if exists create_telegram_preferences_for_profile
  on public.profiles;
create trigger create_telegram_preferences_for_profile
after insert on public.profiles
for each row execute function private.create_telegram_preferences_for_profile();

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

alter table public.telegram_user_links enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.telegram_notification_preferences enable row level security;
alter table public.telegram_notification_deliveries enable row level security;

drop policy if exists telegram_links_select_authorized
  on public.telegram_user_links;
create policy telegram_links_select_authorized
on public.telegram_user_links
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (
    user_id = (select auth.uid())
    or (select private.has_any_role(
      array['owner','admin']::public.app_role[]
    ))
  )
);

drop policy if exists telegram_preferences_select_authorized
  on public.telegram_notification_preferences;
create policy telegram_preferences_select_authorized
on public.telegram_notification_preferences
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (
    user_id = (select auth.uid())
    or (select private.has_any_role(
      array['owner','admin']::public.app_role[]
    ))
  )
);

drop policy if exists telegram_deliveries_select_authorized
  on public.telegram_notification_deliveries;
create policy telegram_deliveries_select_authorized
on public.telegram_notification_deliveries
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (
    user_id = (select auth.uid())
    or (select private.has_any_role(
      array['owner','admin']::public.app_role[]
    ))
  )
);

-- One-time codes must be accessed only through secure RPC/service-role paths.
revoke all on public.telegram_link_codes from anon, authenticated;
revoke all on public.telegram_user_links from anon;
revoke all on public.telegram_notification_preferences from anon;
revoke all on public.telegram_notification_deliveries from anon;

grant select on public.telegram_user_links to authenticated;
grant select on public.telegram_notification_preferences to authenticated;
grant select on public.telegram_notification_deliveries to authenticated;

grant all on public.telegram_user_links to service_role;
grant all on public.telegram_link_codes to service_role;
grant all on public.telegram_notification_preferences to service_role;
grant all on public.telegram_notification_deliveries to service_role;

-- ----------------------------------------------------------------------------
-- Browser link code
-- ----------------------------------------------------------------------------

create or replace function public.create_my_telegram_link_code()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_code text;
  v_expires_at timestamptz := now() + interval '10 minutes';
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active POS profile required';
  end if;

  perform private.ensure_telegram_preferences(v_user_id);

  delete from public.telegram_link_codes
  where user_id = v_user_id
     or expires_at <= now()
     or used_at is not null;

  v_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8));

  insert into public.telegram_link_codes (
    organization_id,
    user_id,
    code_hash,
    expires_at
  )
  values (
    v_profile.organization_id,
    v_user_id,
    encode(digest(v_code, 'sha256'), 'hex'),
    v_expires_at
  );

  return jsonb_build_object(
    'code', v_code,
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.create_my_telegram_link_code()
  from public, anon;
grant execute on function public.create_my_telegram_link_code()
  to authenticated;

-- ----------------------------------------------------------------------------
-- Personal preferences
-- ----------------------------------------------------------------------------

create or replace function public.save_my_telegram_preferences(
  p_preferences jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_result public.telegram_notification_preferences%rowtype;
  v_all_branches boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active POS profile required';
  end if;

  perform private.ensure_telegram_preferences(v_user_id);

  v_all_branches := coalesce(
    (p_preferences ->> 'all_branches')::boolean,
    false
  );

  if v_all_branches
     and v_profile.role not in ('owner','admin') then
    raise exception 'Only owners and admins can receive all-branch alerts';
  end if;

  update public.telegram_notification_preferences
  set
    stock_alerts = coalesce(
      (p_preferences ->> 'stock_alerts')::boolean,
      stock_alerts
    ),
    sales_summary = coalesce(
      (p_preferences ->> 'sales_summary')::boolean,
      sales_summary
    ),
    credit_alerts = coalesce(
      (p_preferences ->> 'credit_alerts')::boolean,
      credit_alerts
    ),
    supplier_alerts = coalesce(
      (p_preferences ->> 'supplier_alerts')::boolean,
      supplier_alerts
    ),
    purchase_alerts = coalesce(
      (p_preferences ->> 'purchase_alerts')::boolean,
      purchase_alerts
    ),
    transfer_alerts = coalesce(
      (p_preferences ->> 'transfer_alerts')::boolean,
      transfer_alerts
    ),
    quotation_alerts = coalesce(
      (p_preferences ->> 'quotation_alerts')::boolean,
      quotation_alerts
    ),
    cash_register_alerts = coalesce(
      (p_preferences ->> 'cash_register_alerts')::boolean,
      cash_register_alerts
    ),
    system_alerts = coalesce(
      (p_preferences ->> 'system_alerts')::boolean,
      system_alerts
    ),
    all_branches = v_all_branches,
    daily_summary_hour = greatest(
      0,
      least(
        23,
        coalesce(
          (p_preferences ->> 'daily_summary_hour')::integer,
          daily_summary_hour
        )
      )
    ),
    quiet_start_hour = case
      when p_preferences ? 'quiet_start_hour'
        and nullif(p_preferences ->> 'quiet_start_hour', '') is not null
      then greatest(0, least(23, (p_preferences ->> 'quiet_start_hour')::integer))
      else null
    end,
    quiet_end_hour = case
      when p_preferences ? 'quiet_end_hour'
        and nullif(p_preferences ->> 'quiet_end_hour', '') is not null
      then greatest(0, least(23, (p_preferences ->> 'quiet_end_hour')::integer))
      else null
    end,
    updated_by = v_user_id,
    updated_at = now()
  where user_id = v_user_id
  returning * into v_result;

  return to_jsonb(v_result);
end;
$$;

revoke all on function public.save_my_telegram_preferences(jsonb)
  from public, anon;
grant execute on function public.save_my_telegram_preferences(jsonb)
  to authenticated;

create or replace function public.disconnect_my_telegram()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_rows integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  update public.telegram_user_links
  set
    is_active = false,
    updated_at = now()
  where user_id = v_user_id
    and is_active = true;

  get diagnostics v_rows = row_count;

  delete from public.telegram_link_codes
  where user_id = v_user_id;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  )
  select
    profile_row.organization_id,
    profile_row.branch_id,
    profile_row.id,
    'disconnect_telegram',
    'telegram_user_link',
    null,
    jsonb_build_object('disconnected', v_rows > 0)
  from public.profiles profile_row
  where profile_row.id = v_user_id;

  return jsonb_build_object(
    'ok', true,
    'disconnected', v_rows > 0
  );
end;
$$;

revoke all on function public.disconnect_my_telegram()
  from public, anon;
grant execute on function public.disconnect_my_telegram()
  to authenticated;

commit;

-- ============================================================================
-- END STEP 31
-- ============================================================================
