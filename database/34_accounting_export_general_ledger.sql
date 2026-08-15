-- ============================================================================
-- Tiny POS - Step 39: Accounting Export, General Ledger and Manual Journals
-- Run once in the NEW Supabase project after Step 38.
--
-- Adds:
--   * Organization chart of accounts and operational account mappings
--   * Read-only double-entry journals derived from existing POS transactions
--   * Separate USD and KHR trial balance, profit/loss and balance summary
--   * Balanced manual journals, opening entries and accounting adjustments
--   * Branch-aware accounting periods, closing controls and CSV-ready reports
--
-- IMPORTANT:
--   Operational POS records remain the source of truth. This migration does not
--   rewrite sales, stock, payments, purchases, returns or cash-register records.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PERMISSIONS
-- ----------------------------------------------------------------------------

insert into public.permission_definitions (
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
)
values
  ('accounting.view','Accounting','View Accounting',
   'View branch-aware general ledger, trial balance and financial statements.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,280),
  ('accounting.export','Accounting','Export Accounting',
   'Export accounting ledger and trial-balance CSV files.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,281),
  ('accounting.manage','Accounting','Manage Accounting',
   'Manage chart of accounts, mappings, manual journals and accounting periods.',
   'critical',array['owner','admin']::public.app_role[],false,282)
on conflict(permission_key) do update set
  module_key=excluded.module_key,
  label=excluded.label,
  description=excluded.description,
  risk_level=excluded.risk_level,
  default_roles=excluded.default_roles,
  approval_action=excluded.approval_action,
  sort_order=excluded.sort_order,
  is_active=true,
  updated_at=now();

-- ----------------------------------------------------------------------------
-- 2. ACCOUNTING TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check(length(trim(code)) between 2 and 20),
  name text not null check(length(trim(name)) between 2 and 120),
  account_type text not null check(account_type in('asset','liability','equity','income','expense')),
  normal_balance text not null check(normal_balance in('debit','credit')),
  is_system boolean not null default false,
  is_active boolean not null default true,
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,code)
);

create index if not exists accounting_accounts_org_type_idx
  on public.accounting_accounts(organization_id,account_type,is_active,code);

drop trigger if exists set_accounting_accounts_updated_at on public.accounting_accounts;
create trigger set_accounting_accounts_updated_at
before update on public.accounting_accounts
for each row execute function public.set_updated_at();

create table if not exists public.accounting_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mapping_key text not null check(mapping_key ~ '^[a-z0-9_]{3,60}$'),
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,mapping_key)
);

drop trigger if exists set_accounting_mappings_updated_at on public.accounting_mappings;
create trigger set_accounting_mappings_updated_at
before update on public.accounting_mappings
for each row execute function public.set_updated_at();

create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check(status in('open','closed')),
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(period_end>=period_start),
  check((status='open' and closed_at is null) or status='closed')
);

create unique index if not exists accounting_periods_scope_uq
  on public.accounting_periods(
    organization_id,
    coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
    period_start,
    period_end
  );

drop trigger if exists set_accounting_periods_updated_at on public.accounting_periods;
create trigger set_accounting_periods_updated_at
before update on public.accounting_periods
for each row execute function public.set_updated_at();

create table if not exists public.accounting_journal_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete restrict,
  journal_number text not null,
  entry_date date not null,
  currency public.currency_code not null,
  description text not null check(length(trim(description)) between 3 and 240),
  reference_number text,
  source_type text not null default 'manual'
    check(source_type in('manual','opening','adjustment')),
  status text not null default 'posted' check(status in('posted','voided')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  voided_by uuid references public.profiles(id) on delete set null,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,journal_number)
);

create index if not exists accounting_journals_org_date_idx
  on public.accounting_journal_entries(organization_id,entry_date desc,branch_id,currency,status);

drop trigger if exists set_accounting_journal_entries_updated_at on public.accounting_journal_entries;
create trigger set_accounting_journal_entries_updated_at
before update on public.accounting_journal_entries
for each row execute function public.set_updated_at();

create table if not exists public.accounting_journal_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  journal_entry_id uuid not null references public.accounting_journal_entries(id) on delete cascade,
  line_number integer not null check(line_number>0),
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  description text,
  debit numeric(16,2) not null default 0 check(debit>=0),
  credit numeric(16,2) not null default 0 check(credit>=0),
  created_at timestamptz not null default now(),
  check((debit>0 and credit=0) or (credit>0 and debit=0)),
  unique(journal_entry_id,line_number)
);

create index if not exists accounting_journal_lines_account_idx
  on public.accounting_journal_lines(account_id,journal_entry_id);

-- ----------------------------------------------------------------------------
-- 3. DEFAULT CHART OF ACCOUNTS AND MAPPINGS
-- ----------------------------------------------------------------------------

create or replace function private.ensure_accounting_defaults(
  p_organization_id uuid,
  p_user_id uuid default null
)
returns void language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  r record;
  v_account_id uuid;
begin
  for r in
    select * from (values
      ('1000','Cash on Hand','asset','debit','Physical cash held by the business.'),
      ('1010','Bank Account','asset','debit','Bank deposits and bank transfers.'),
      ('1020','Card Clearing','asset','debit','Card payments waiting for settlement.'),
      ('1030','KHQR Clearing','asset','debit','KHQR payments waiting for settlement.'),
      ('1040','Other Payment Clearing','asset','debit','Other payment methods and reconciliation differences.'),
      ('1100','Accounts Receivable','asset','debit','Customer credit balances due.'),
      ('1200','Inventory','asset','debit','Inventory at recorded cost.'),
      ('2000','Accounts Payable','liability','credit','Supplier balances due.'),
      ('2100','Tax Payable','liability','credit','Sales tax collected and payable.'),
      ('3000','Owner Equity','equity','credit','Owner contributions and withdrawals.'),
      ('3100','Retained Earnings','equity','credit','Accumulated earnings retained in the business.'),
      ('4000','Sales Revenue','income','credit','Net product sales before sales returns.'),
      ('4010','Other Income','income','credit','Non-sale operating income.'),
      ('4090','Sales Returns','income','debit','Contra-revenue for customer returns and refunds.'),
      ('5000','Cost of Goods Sold','expense','debit','Recorded cost of products sold.'),
      ('5100','Operating Expense','expense','debit','General operating expenses.'),
      ('5200','Commission Expense','expense','debit','Paid staff sales commissions.'),
      ('5300','Inventory Adjustment Loss','expense','debit','Inventory write-offs and negative adjustments.'),
      ('5310','Inventory Adjustment Gain','income','credit','Positive inventory adjustments.')
    ) as x(code,name,account_type,normal_balance,description)
  loop
    insert into public.accounting_accounts(
      organization_id,code,name,account_type,normal_balance,is_system,is_active,
      description,created_by,updated_by
    ) values(
      p_organization_id,r.code,r.name,r.account_type,r.normal_balance,true,true,
      r.description,p_user_id,p_user_id
    )
    on conflict(organization_id,code) do nothing;
  end loop;

  for r in
    select * from (values
      ('cash_on_hand','1000','Cash receipts and cash payments.'),
      ('bank','1010','Bank receipts and bank payments.'),
      ('card_clearing','1020','Card payment receipts.'),
      ('khqr_clearing','1030','KHQR payment receipts.'),
      ('other_payment','1040','Other payment receipts and balancing differences.'),
      ('accounts_receivable','1100','Customer credit invoices and collections.'),
      ('inventory','1200','Purchased, returned and adjusted inventory.'),
      ('accounts_payable','2000','Purchase receipts, supplier payments and supplier returns.'),
      ('tax_payable','2100','Tax collected on completed sales.'),
      ('owner_equity','3000','Owner contributions and withdrawals.'),
      ('sales_revenue','4000','Completed-sale revenue after discounts.'),
      ('other_income','4010','Profit-affecting cash income.'),
      ('sales_returns','4090','Customer return and refund value.'),
      ('cost_of_goods_sold','5000','Recorded product cost on completed sales.'),
      ('operating_expense','5100','Profit-affecting cash expenses.'),
      ('commission_expense','5200','Recorded commission payouts.'),
      ('inventory_adjustment_loss','5300','Negative inventory adjustments.'),
      ('inventory_adjustment_gain','5310','Positive inventory adjustments.')
    ) as x(mapping_key,account_code,description)
  loop
    select a.id into v_account_id
    from public.accounting_accounts a
    where a.organization_id=p_organization_id and a.code=r.account_code;

    insert into public.accounting_mappings(
      organization_id,mapping_key,account_id,description,created_by,updated_by
    ) values(
      p_organization_id,r.mapping_key,v_account_id,r.description,p_user_id,p_user_id
    )
    on conflict(organization_id,mapping_key) do nothing;
  end loop;
end $$;

revoke all on function private.ensure_accounting_defaults(uuid,uuid) from public;
grant execute on function private.ensure_accounting_defaults(uuid,uuid) to authenticated,service_role;

select private.ensure_accounting_defaults(o.id,null)
from public.organizations o;

create or replace function private.seed_new_organization_accounting()
returns trigger language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  perform private.ensure_accounting_defaults(new.id,null);
  return new;
end $$;

drop trigger if exists seed_new_organization_accounting on public.organizations;
create trigger seed_new_organization_accounting
after insert on public.organizations
for each row execute function private.seed_new_organization_accounting();

-- ----------------------------------------------------------------------------
-- 4. ACCESS AND PERIOD HELPERS
-- ----------------------------------------------------------------------------

create or replace function private.accounting_branch_allowed(p_branch_id uuid)
returns boolean language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select coalesce(
    p_branch_id is null
    or private.has_permission('branches.all',auth.uid())
    or p_branch_id=private.current_branch_id(),
    false
  )
$$;

create or replace function private.accounting_period_closed(
  p_organization_id uuid,p_branch_id uuid,p_entry_date date
)
returns boolean language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select exists(
    select 1 from public.accounting_periods p
    where p.organization_id=p_organization_id
      and p.status='closed'
      and p_entry_date between p.period_start and p.period_end
      and (p.branch_id is null or p.branch_id=p_branch_id)
  )
$$;

revoke all on function private.accounting_branch_allowed(uuid) from public;
revoke all on function private.accounting_period_closed(uuid,uuid,date) from public;
grant execute on function private.accounting_branch_allowed(uuid) to authenticated,service_role;
grant execute on function private.accounting_period_closed(uuid,uuid,date) to authenticated,service_role;

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------

alter table public.accounting_accounts enable row level security;
alter table public.accounting_mappings enable row level security;
alter table public.accounting_periods enable row level security;
alter table public.accounting_journal_entries enable row level security;
alter table public.accounting_journal_lines enable row level security;

do $$
declare r record;
begin
  for r in select schemaname,tablename,policyname from pg_policies
    where schemaname='public' and tablename in(
      'accounting_accounts','accounting_mappings','accounting_periods',
      'accounting_journal_entries','accounting_journal_lines'
    )
  loop execute format('drop policy if exists %I on %I.%I',r.policyname,r.schemaname,r.tablename); end loop;
end $$;

create policy accounting_accounts_read on public.accounting_accounts
for select to authenticated using(
  organization_id=private.current_organization_id()
  and private.has_permission('accounting.view',auth.uid())
);
create policy accounting_mappings_read on public.accounting_mappings
for select to authenticated using(
  organization_id=private.current_organization_id()
  and private.has_permission('accounting.view',auth.uid())
);
create policy accounting_periods_read on public.accounting_periods
for select to authenticated using(
  organization_id=private.current_organization_id()
  and private.has_permission('accounting.view',auth.uid())
  and private.accounting_branch_allowed(branch_id)
);
create policy accounting_journals_read on public.accounting_journal_entries
for select to authenticated using(
  organization_id=private.current_organization_id()
  and private.has_permission('accounting.view',auth.uid())
  and private.accounting_branch_allowed(branch_id)
);
create policy accounting_lines_read on public.accounting_journal_lines
for select to authenticated using(
  organization_id=private.current_organization_id()
  and private.has_permission('accounting.view',auth.uid())
  and exists(
    select 1 from public.accounting_journal_entries e
    where e.id=journal_entry_id and private.accounting_branch_allowed(e.branch_id)
  )
);

revoke all on public.accounting_accounts,public.accounting_mappings,
  public.accounting_periods,public.accounting_journal_entries,
  public.accounting_journal_lines from anon;
grant select on public.accounting_accounts,public.accounting_mappings,
  public.accounting_periods,public.accounting_journal_entries,
  public.accounting_journal_lines to authenticated;
grant all on public.accounting_accounts,public.accounting_mappings,
  public.accounting_periods,public.accounting_journal_entries,
  public.accounting_journal_lines to service_role;

-- ----------------------------------------------------------------------------
-- 6. MANAGEMENT RPCS
-- ----------------------------------------------------------------------------

create or replace function public.save_accounting_account(
  p_account_id uuid,p_code text,p_name text,p_account_type text,
  p_normal_balance text,p_is_active boolean default true,p_description text default null
)
returns public.accounting_accounts language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_row public.accounting_accounts%rowtype;
begin
  perform private.require_permission('accounting.manage');
  if p_account_type not in('asset','liability','equity','income','expense') then raise exception 'Invalid account type'; end if;
  if p_normal_balance not in('debit','credit') then raise exception 'Invalid normal balance'; end if;
  if nullif(trim(p_code),'') is null or nullif(trim(p_name),'') is null then raise exception 'Account code and name are required'; end if;

  if p_account_id is null then
    insert into public.accounting_accounts(
      organization_id,code,name,account_type,normal_balance,is_system,is_active,
      description,created_by,updated_by
    ) values(
      v_org,upper(trim(p_code)),trim(p_name),p_account_type,p_normal_balance,false,
      coalesce(p_is_active,true),nullif(trim(coalesce(p_description,'')),''),auth.uid(),auth.uid()
    ) returning * into v_row;
  else
    update public.accounting_accounts a set
      code=case when a.is_system then a.code else upper(trim(p_code)) end,
      name=trim(p_name),account_type=p_account_type,normal_balance=p_normal_balance,
      is_active=coalesce(p_is_active,true),description=nullif(trim(coalesce(p_description,'')),''),
      updated_by=auth.uid(),updated_at=now()
    where a.id=p_account_id and a.organization_id=v_org
    returning * into v_row;
    if not found then raise exception 'Accounting account not found'; end if;
  end if;

  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),case when p_account_id is null then 'create_accounting_account' else 'update_accounting_account' end,
    'accounting_account',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.save_accounting_mapping(
  p_mapping_key text,p_account_id uuid
)
returns public.accounting_mappings language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_row public.accounting_mappings%rowtype;
begin
  perform private.require_permission('accounting.manage');
  if not exists(select 1 from public.accounting_accounts a where a.id=p_account_id and a.organization_id=v_org and a.is_active=true) then
    raise exception 'Active accounting account not found';
  end if;
  if p_mapping_key not in(
    'cash_on_hand','bank','card_clearing','khqr_clearing','other_payment',
    'accounts_receivable','inventory','accounts_payable','tax_payable','owner_equity',
    'sales_revenue','other_income','sales_returns','cost_of_goods_sold',
    'operating_expense','commission_expense','inventory_adjustment_loss','inventory_adjustment_gain'
  ) then raise exception 'Unknown accounting mapping'; end if;

  insert into public.accounting_mappings(organization_id,mapping_key,account_id,created_by,updated_by)
  values(v_org,p_mapping_key,p_account_id,auth.uid(),auth.uid())
  on conflict(organization_id,mapping_key) do update set
    account_id=excluded.account_id,updated_by=auth.uid(),updated_at=now()
  returning * into v_row;

  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'update_accounting_mapping','accounting_mapping',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.save_manual_journal(
  p_journal_id uuid,p_branch_id uuid,p_entry_date date,p_currency public.currency_code,
  p_description text,p_reference_number text,p_source_type text,p_lines jsonb
)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_branch uuid:=coalesce(p_branch_id,private.current_branch_id());
  v_entry public.accounting_journal_entries%rowtype;
  v_line jsonb;
  v_number integer:=0;
  v_debit numeric(16,2):=0;
  v_credit numeric(16,2):=0;
  v_account uuid;
begin
  perform private.require_permission('accounting.manage');
  if not private.accounting_branch_allowed(v_branch) then raise exception 'Branch access denied'; end if;
  if p_entry_date is null then raise exception 'Entry date is required'; end if;
  if private.accounting_period_closed(v_org,v_branch,p_entry_date) then raise exception 'This accounting period is closed'; end if;
  if p_source_type not in('manual','opening','adjustment') then raise exception 'Invalid journal type'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)<2 then raise exception 'At least two journal lines are required'; end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_account:=nullif(v_line->>'account_id','')::uuid;
    if not exists(select 1 from public.accounting_accounts a where a.id=v_account and a.organization_id=v_org and a.is_active=true) then
      raise exception 'A selected accounting account is missing or inactive';
    end if;
    if coalesce((v_line->>'debit')::numeric,0)<0 or coalesce((v_line->>'credit')::numeric,0)<0 then raise exception 'Debit and credit cannot be negative'; end if;
    if (coalesce((v_line->>'debit')::numeric,0)>0)=(coalesce((v_line->>'credit')::numeric,0)>0) then
      raise exception 'Each journal line must contain either a debit or a credit';
    end if;
    v_debit:=v_debit+round(coalesce((v_line->>'debit')::numeric,0),2);
    v_credit:=v_credit+round(coalesce((v_line->>'credit')::numeric,0),2);
  end loop;
  if round(v_debit,2)<>round(v_credit,2) then raise exception 'Journal is not balanced. Debits: %, Credits: %',v_debit,v_credit; end if;

  if p_journal_id is null then
    insert into public.accounting_journal_entries(
      organization_id,branch_id,journal_number,entry_date,currency,description,
      reference_number,source_type,status,created_by
    ) values(
      v_org,v_branch,private.next_document_number(v_org,v_branch,'JRN'),p_entry_date,p_currency,
      trim(p_description),nullif(trim(coalesce(p_reference_number,'')),''),p_source_type,'posted',auth.uid()
    ) returning * into v_entry;
  else
    update public.accounting_journal_entries e set
      branch_id=v_branch,entry_date=p_entry_date,currency=p_currency,description=trim(p_description),
      reference_number=nullif(trim(coalesce(p_reference_number,'')),''),source_type=p_source_type,updated_at=now()
    where e.id=p_journal_id and e.organization_id=v_org and e.status='posted'
      and e.source_type in('manual','opening','adjustment')
    returning * into v_entry;
    if not found then raise exception 'Editable manual journal not found'; end if;
    delete from public.accounting_journal_lines where journal_entry_id=v_entry.id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_number:=v_number+1;
    insert into public.accounting_journal_lines(
      organization_id,journal_entry_id,line_number,account_id,description,debit,credit
    ) values(
      v_org,v_entry.id,v_number,(v_line->>'account_id')::uuid,
      nullif(trim(coalesce(v_line->>'description','')),''),
      round(coalesce((v_line->>'debit')::numeric,0),2),
      round(coalesce((v_line->>'credit')::numeric,0),2)
    );
  end loop;

  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),case when p_journal_id is null then 'create_manual_journal' else 'update_manual_journal' end,
    'accounting_journal',v_entry.id,jsonb_build_object('entry',to_jsonb(v_entry),'debit',v_debit,'credit',v_credit));
  return jsonb_build_object('ok',true,'journal',to_jsonb(v_entry),'debit',v_debit,'credit',v_credit);
end $$;

create or replace function public.void_manual_journal(
  p_journal_id uuid,p_reason text
)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_row public.accounting_journal_entries%rowtype;
begin
  perform private.require_permission('accounting.manage');
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'Void reason is required'; end if;
  select * into v_row from public.accounting_journal_entries e
  where e.id=p_journal_id and e.organization_id=v_org and e.status='posted'
    and e.source_type in('manual','opening','adjustment') for update;
  if not found then raise exception 'Posted manual journal not found'; end if;
  if private.accounting_period_closed(v_org,v_row.branch_id,v_row.entry_date) then raise exception 'This accounting period is closed'; end if;
  update public.accounting_journal_entries set status='voided',voided_by=auth.uid(),voided_at=now(),void_reason=trim(p_reason),updated_at=now()
  where id=v_row.id returning * into v_row;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_row.branch_id,auth.uid(),'void_manual_journal','accounting_journal',v_row.id,to_jsonb(v_row));
  return jsonb_build_object('ok',true,'journal',to_jsonb(v_row));
end $$;

create or replace function public.set_accounting_period_status(
  p_branch_id uuid,p_year integer,p_month integer,p_status text,p_notes text default null
)
returns public.accounting_periods language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_start date; v_end date; v_row public.accounting_periods%rowtype;
begin
  perform private.require_permission('accounting.manage');
  if p_year not between 2000 and 2200 or p_month not between 1 and 12 then raise exception 'Invalid accounting period'; end if;
  if p_status not in('open','closed') then raise exception 'Invalid period status'; end if;
  if p_branch_id is not null and not private.accounting_branch_allowed(p_branch_id) then raise exception 'Branch access denied'; end if;
  v_start:=make_date(p_year,p_month,1);
  v_end:=(v_start+interval '1 month-1 day')::date;

  select * into v_row from public.accounting_periods p
  where p.organization_id=v_org and p.branch_id is not distinct from p_branch_id
    and p.period_start=v_start and p.period_end=v_end for update;

  if found then
    update public.accounting_periods set
      status=p_status,
      closed_by=case when p_status='closed' then auth.uid() else null end,
      closed_at=case when p_status='closed' then now() else null end,
      notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=now()
    where id=v_row.id returning * into v_row;
  else
    insert into public.accounting_periods(
      organization_id,branch_id,period_start,period_end,status,closed_by,closed_at,notes
    ) values(
      v_org,p_branch_id,v_start,v_end,p_status,
      case when p_status='closed' then auth.uid() else null end,
      case when p_status='closed' then now() else null end,
      nullif(trim(coalesce(p_notes,'')),'')
    ) returning * into v_row;
  end if;

  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,p_branch_id,auth.uid(),case when p_status='closed' then 'close_accounting_period' else 'reopen_accounting_period' end,
    'accounting_period',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

-- ----------------------------------------------------------------------------
-- 7. READ-ONLY DERIVED DOUBLE-ENTRY LEDGER
-- ----------------------------------------------------------------------------

create or replace function private.accounting_source_lines(
  p_organization_id uuid,p_branch_id uuid,p_from date,p_to date
)
returns table(
  entry_date date,branch_id uuid,branch_name text,currency public.currency_code,
  source_type text,source_id uuid,source_number text,description text,
  account_id uuid,account_code text,account_name text,account_type text,
  normal_balance text,debit numeric,credit numeric
)
language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
with mappings as (
  select m.mapping_key,m.account_id
  from public.accounting_mappings m
  where m.organization_id=p_organization_id
),
sales_scope as (
  select s.*,
    timezone('Asia/Bangkok',coalesce(s.completed_at,s.created_at))::date as business_date,
    coalesce((select sum(p.amount) from public.payments p where p.sale_id=s.id and p.credit_payment_id is null),0)::numeric as immediate_paid
  from public.sales s
  where s.organization_id=p_organization_id and s.status::text='completed'
    and timezone('Asia/Bangkok',coalesce(s.completed_at,s.created_at))::date between p_from and p_to
    and (p_branch_id is null or s.branch_id=p_branch_id)
),
return_scope as (
  select r.*,
    timezone('Asia/Bangkok',r.processed_at)::date as business_date,
    least(
      r.refund_amount,
      greatest(
        round(r.refund_amount*coalesce(s.tax_amount,0)/nullif(s.total_amount,0),2),
        0
      )
    )::numeric as tax_reversal
  from public.returns r
  join public.sales s on s.id=r.original_sale_id
  where r.organization_id=p_organization_id and r.status::text='completed'
    and timezone('Asia/Bangkok',r.processed_at)::date between p_from and p_to
    and (p_branch_id is null or r.branch_id=p_branch_id)
),
return_costs as (
  select r.id as return_id,coalesce(sum(ri.quantity*si.unit_cost) filter(where ri.restock),0)::numeric as restock_cost
  from public.returns r
  join public.return_items ri on ri.return_id=r.id
  join public.sale_items si on si.id=ri.sale_item_id
  where r.organization_id=p_organization_id and r.status::text='completed'
  group by r.id
),
receipt_totals as (
  select pr.id,coalesce(sum(pri.line_total),0)::numeric as amount
  from public.purchase_receipts pr
  join public.purchase_receipt_items pri on pri.receipt_id=pr.id
  where pr.organization_id=p_organization_id group by pr.id
),
adjustment_values as (
  select a.id,coalesce(sum(ai.quantity_change*ai.unit_cost),0)::numeric as value
  from public.inventory_adjustments a
  join public.inventory_adjustment_items ai on ai.adjustment_id=a.id
  where a.organization_id=p_organization_id group by a.id
),
raw(entry_date,branch_id,currency,source_type,source_id,source_number,description,mapping_key,direct_account_id,debit,credit) as (
  -- Completed sale payment debits.
  select s.business_date,s.branch_id,s.currency,'sale'::text,s.id,s.invoice_number,
    'Sale '||s.invoice_number,
    case p.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,p.amount::numeric,0::numeric
  from sales_scope s join public.payments p on p.sale_id=s.id and p.credit_payment_id is null
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sale '||s.invoice_number,
    'accounts_receivable',null::uuid,s.credit_amount::numeric,0::numeric
  from sales_scope s where s.credit_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sale '||s.invoice_number,
    'other_payment',null::uuid,greatest(s.total_amount-s.credit_amount-s.immediate_paid,0)::numeric,
    greatest(s.credit_amount+s.immediate_paid-s.total_amount,0)::numeric
  from sales_scope s where abs(s.total_amount-s.credit_amount-s.immediate_paid)>0.005
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sale revenue '||s.invoice_number,
    'sales_revenue',null::uuid,0::numeric,greatest(s.total_amount-s.tax_amount,0)::numeric
  from sales_scope s where s.total_amount-s.tax_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sales tax '||s.invoice_number,
    'tax_payable',null::uuid,0::numeric,s.tax_amount::numeric
  from sales_scope s where s.tax_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Cost of goods sold '||s.invoice_number,
    'cost_of_goods_sold',null::uuid,s.cost_amount::numeric,0::numeric
  from sales_scope s where s.cost_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Inventory issued '||s.invoice_number,
    'inventory',null::uuid,0::numeric,s.cost_amount::numeric
  from sales_scope s where s.cost_amount>0

  -- Customer credit collections.
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'credit_payment',cp.id,cp.payment_number,
    'Customer credit collection '||cp.payment_number,
    case cp.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,cp.amount::numeric,0::numeric
  from public.customer_credit_payments cp
  where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'credit_payment',cp.id,cp.payment_number,
    'Customer credit collection '||cp.payment_number,'accounts_receivable',null::uuid,0::numeric,cp.amount::numeric
  from public.customer_credit_payments cp
  where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)

  -- Customer returns, tax reversal and restocking cost reversal.
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Customer return '||r.return_number,'sales_returns',null::uuid,
    greatest(r.refund_amount-r.tax_reversal,0)::numeric,0::numeric
  from return_scope r where r.refund_amount-r.tax_reversal>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Sales tax reversal '||r.return_number,'tax_payable',null::uuid,r.tax_reversal::numeric,0::numeric
  from return_scope r where r.tax_reversal>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Credit refund '||r.return_number,'accounts_receivable',null::uuid,0::numeric,r.credit_refund_amount::numeric
  from return_scope r where r.credit_refund_amount>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Refund payment '||r.return_number,
    case coalesce(r.refund_method::text,'other') when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,0::numeric,greatest(r.refund_amount-r.credit_refund_amount,0)::numeric
  from return_scope r where r.refund_amount-r.credit_refund_amount>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Returned inventory '||r.return_number,'inventory',null::uuid,rc.restock_cost,0::numeric
  from return_scope r join return_costs rc on rc.return_id=r.id where rc.restock_cost>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'COGS reversal '||r.return_number,'cost_of_goods_sold',null::uuid,0::numeric,rc.restock_cost
  from return_scope r join return_costs rc on rc.return_id=r.id where rc.restock_cost>0

  -- Goods received and supplier liabilities.
  union all
  select timezone('Asia/Bangkok',pr.received_at)::date,pr.branch_id,p.currency,'purchase_receipt',pr.id,pr.receipt_number,
    'Goods received '||pr.receipt_number,'inventory',null::uuid,rt.amount,0::numeric
  from public.purchase_receipts pr join receipt_totals rt on rt.id=pr.id join public.purchases p on p.id=pr.purchase_id
  where pr.organization_id=p_organization_id and timezone('Asia/Bangkok',pr.received_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and rt.amount>0
  union all
  select timezone('Asia/Bangkok',pr.received_at)::date,pr.branch_id,p.currency,'purchase_receipt',pr.id,pr.receipt_number,
    'Supplier liability '||pr.receipt_number,'accounts_payable',null::uuid,0::numeric,rt.amount
  from public.purchase_receipts pr join receipt_totals rt on rt.id=pr.id join public.purchases p on p.id=pr.purchase_id
  where pr.organization_id=p_organization_id and timezone('Asia/Bangkok',pr.received_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and rt.amount>0

  -- Supplier payments.
  union all
  select timezone('Asia/Bangkok',sp.paid_at)::date,sp.branch_id,sp.currency,'supplier_payment',sp.id,sp.payment_number,
    'Supplier payment '||sp.payment_number,'accounts_payable',null::uuid,sp.amount::numeric,0::numeric
  from public.supplier_payment_batches sp where sp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',sp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or sp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',sp.paid_at)::date,sp.branch_id,sp.currency,'supplier_payment',sp.id,sp.payment_number,
    'Supplier payment '||sp.payment_number,
    case sp.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,0::numeric,sp.amount::numeric
  from public.supplier_payment_batches sp where sp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',sp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or sp.branch_id=p_branch_id)

  -- Legacy or directly recorded purchase payments not attached to a payment batch.
  union all
  select timezone('Asia/Bangkok',pp.paid_at)::date,pp.branch_id,pp.currency,'purchase_payment',pp.id,
    p.purchase_number,'Purchase payment '||p.purchase_number,'accounts_payable',null::uuid,pp.amount::numeric,0::numeric
  from public.purchase_payments pp join public.purchases p on p.id=pp.purchase_id
  where pp.organization_id=p_organization_id and pp.payment_batch_id is null
    and timezone('Asia/Bangkok',pp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or pp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',pp.paid_at)::date,pp.branch_id,pp.currency,'purchase_payment',pp.id,
    p.purchase_number,'Purchase payment '||p.purchase_number,
    case pp.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,0::numeric,pp.amount::numeric
  from public.purchase_payments pp join public.purchases p on p.id=pp.purchase_id
  where pp.organization_id=p_organization_id and pp.payment_batch_id is null
    and timezone('Asia/Bangkok',pp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or pp.branch_id=p_branch_id)

  -- Supplier returns.
  union all
  select timezone('Asia/Bangkok',pr.created_at)::date,pr.branch_id,pr.currency,'supplier_return',pr.id,pr.return_number,
    'Supplier return '||pr.return_number,'accounts_payable',null::uuid,pr.total_amount::numeric,0::numeric
  from public.purchase_returns pr where pr.organization_id=p_organization_id and pr.status::text='completed'
    and timezone('Asia/Bangkok',pr.created_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and pr.total_amount>0
  union all
  select timezone('Asia/Bangkok',pr.created_at)::date,pr.branch_id,pr.currency,'supplier_return',pr.id,pr.return_number,
    'Inventory returned to supplier '||pr.return_number,'inventory',null::uuid,0::numeric,pr.total_amount::numeric
  from public.purchase_returns pr where pr.organization_id=p_organization_id and pr.status::text='completed'
    and timezone('Asia/Bangkok',pr.created_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and pr.total_amount>0

  -- Cash income and expenses.
  union all
  select timezone('Asia/Bangkok',ce.entry_at)::date,ce.branch_id,ce.currency,'cash_entry',ce.id,ce.entry_number,
    coalesce(cc.name,'Cash entry')||' '||ce.entry_number,
    case ce.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,case when ce.direction::text='income' then ce.amount else 0 end::numeric,
    case when ce.direction::text='expense' then ce.amount else 0 end::numeric
  from public.cash_entries ce join public.cash_categories cc on cc.id=ce.category_id
  where ce.organization_id=p_organization_id and ce.status::text='active'
    and timezone('Asia/Bangkok',ce.entry_at)::date between p_from and p_to
    and (p_branch_id is null or ce.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',ce.entry_at)::date,ce.branch_id,ce.currency,'cash_entry',ce.id,ce.entry_number,
    coalesce(cc.name,'Cash entry')||' '||ce.entry_number,
    case when cc.affects_profit and ce.direction::text='income' then 'other_income'
      when cc.affects_profit and ce.direction::text='expense' then 'operating_expense'
      else 'owner_equity' end,
    null::uuid,case when ce.direction::text='expense' then ce.amount else 0 end::numeric,
    case when ce.direction::text='income' then ce.amount else 0 end::numeric
  from public.cash_entries ce join public.cash_categories cc on cc.id=ce.category_id
  where ce.organization_id=p_organization_id and ce.status::text='active'
    and timezone('Asia/Bangkok',ce.entry_at)::date between p_from and p_to
    and (p_branch_id is null or ce.branch_id=p_branch_id)

  -- Commission payouts.
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'commission_payout',cp.id,
    'COM-'||left(cp.id::text,8),'Commission payout','commission_expense',null::uuid,cp.amount::numeric,0::numeric
  from public.commission_payouts cp where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'commission_payout',cp.id,
    'COM-'||left(cp.id::text,8),'Commission payout',
    case cp.payment_method when 'cash' then 'cash_on_hand' when 'bank' then 'bank' else 'other_payment' end,
    null::uuid,0::numeric,cp.amount::numeric
  from public.commission_payouts cp where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)

  -- Inventory adjustments.
  union all
  select timezone('Asia/Bangkok',a.created_at)::date,a.branch_id,'USD'::public.currency_code,'inventory_adjustment',a.id,a.adjustment_number,
    'Inventory adjustment '||a.adjustment_number,
    case when av.value>0 then 'inventory' else 'inventory_adjustment_loss' end,
    null::uuid,abs(av.value)::numeric,0::numeric
  from public.inventory_adjustments a join adjustment_values av on av.id=a.id
  where a.organization_id=p_organization_id and av.value<>0
    and timezone('Asia/Bangkok',a.created_at)::date between p_from and p_to
    and (p_branch_id is null or a.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',a.created_at)::date,a.branch_id,'USD'::public.currency_code,'inventory_adjustment',a.id,a.adjustment_number,
    'Inventory adjustment '||a.adjustment_number,
    case when av.value>0 then 'inventory_adjustment_gain' else 'inventory' end,
    null::uuid,0::numeric,abs(av.value)::numeric
  from public.inventory_adjustments a join adjustment_values av on av.id=a.id
  where a.organization_id=p_organization_id and av.value<>0
    and timezone('Asia/Bangkok',a.created_at)::date between p_from and p_to
    and (p_branch_id is null or a.branch_id=p_branch_id)

  -- Manual/opening/adjustment journals.
  union all
  select e.entry_date,e.branch_id,e.currency,'manual_journal',e.id,e.journal_number,e.description,
    null::text,l.account_id,l.debit::numeric,l.credit::numeric
  from public.accounting_journal_entries e
  join public.accounting_journal_lines l on l.journal_entry_id=e.id
  where e.organization_id=p_organization_id and e.status='posted'
    and e.entry_date between p_from and p_to
    and (p_branch_id is null or e.branch_id=p_branch_id)
),
resolved as (
  select r.*,coalesce(r.direct_account_id,m.account_id) as resolved_account_id
  from raw r left join mappings m on m.mapping_key=r.mapping_key
)
select r.entry_date,r.branch_id,b.name,r.currency,r.source_type,r.source_id,r.source_number,r.description,
  a.id,a.code,a.name,a.account_type,a.normal_balance,round(r.debit,2),round(r.credit,2)
from resolved r
join public.accounting_accounts a on a.id=r.resolved_account_id and a.organization_id=p_organization_id
left join public.branches b on b.id=r.branch_id
where r.debit<>0 or r.credit<>0
$$;

revoke all on function private.accounting_source_lines(uuid,uuid,date,date) from public;
grant execute on function private.accounting_source_lines(uuid,uuid,date,date) to authenticated,service_role;

create or replace function public.get_accounting_workspace()
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_branch uuid;
begin
  perform private.require_permission('accounting.view');
  perform private.ensure_accounting_defaults(v_org,auth.uid());
  v_branch:=case when private.has_permission('branches.all',auth.uid()) then null else private.current_branch_id() end;
  return jsonb_build_object(
    'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.code) from public.accounting_accounts a where a.organization_id=v_org),'[]'::jsonb),
    'mappings',coalesce((select jsonb_agg(to_jsonb(x) order by x.mapping_key) from(
      select m.*,a.code as account_code,a.name as account_name,a.account_type
      from public.accounting_mappings m join public.accounting_accounts a on a.id=m.account_id
      where m.organization_id=v_org
    ) x),'[]'::jsonb),
    'branches',coalesce((select jsonb_agg(to_jsonb(b) order by b.name) from public.branches b
      where b.organization_id=v_org and b.is_active=true and (v_branch is null or b.id=v_branch)),'[]'::jsonb),
    'periods',coalesce((select jsonb_agg(to_jsonb(x) order by x.period_start desc,x.branch_name) from(
      select p.*,b.name as branch_name from public.accounting_periods p left join public.branches b on b.id=p.branch_id
      where p.organization_id=v_org and (v_branch is null or p.branch_id is null or p.branch_id=v_branch)
      order by p.period_start desc limit 60
    ) x),'[]'::jsonb),
    'journals',coalesce((select jsonb_agg(to_jsonb(x) order by x.entry_date desc,x.created_at desc) from(
      select e.*,b.name as branch_name,pr.full_name as created_by_name,
        coalesce((select jsonb_agg(to_jsonb(y) order by y.line_number) from(
          select l.*,a.code as account_code,a.name as account_name,a.account_type
          from public.accounting_journal_lines l join public.accounting_accounts a on a.id=l.account_id
          where l.journal_entry_id=e.id
        ) y),'[]'::jsonb) as lines
      from public.accounting_journal_entries e
      left join public.branches b on b.id=e.branch_id
      left join public.profiles pr on pr.id=e.created_by
      where e.organization_id=v_org and (v_branch is null or e.branch_id=v_branch)
      order by e.entry_date desc,e.created_at desc limit 300
    ) x),'[]'::jsonb),
    'can_manage',private.has_permission('accounting.manage',auth.uid()),
    'can_export',private.has_permission('accounting.export',auth.uid()),
    'all_branches',private.has_permission('branches.all',auth.uid())
  );
end $$;

create or replace function public.get_accounting_report(
  p_from date,p_to date,p_branch_id uuid default null
)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_branch uuid:=p_branch_id;
begin
  perform private.require_permission('accounting.view');
  if p_from is null or p_to is null or p_to<p_from then raise exception 'Invalid accounting date range'; end if;
  if p_to-p_from>730 then raise exception 'Accounting report range cannot exceed 730 days'; end if;
  if v_branch is null and not private.has_permission('branches.all',auth.uid()) then v_branch:=private.current_branch_id(); end if;
  if v_branch is not null and not private.accounting_branch_allowed(v_branch) then raise exception 'Branch access denied'; end if;
  perform private.ensure_accounting_defaults(v_org,auth.uid());

  return jsonb_build_object(
    'date_from',p_from,'date_to',p_to,'branch_id',v_branch,
    'summary',coalesce((
      with p as (select * from private.accounting_source_lines(v_org,v_branch,p_from,p_to)),
      a as (select * from private.accounting_source_lines(v_org,v_branch,'2000-01-01'::date,p_to)),
      currencies as (select currency from p union select currency from a)
      select jsonb_agg(jsonb_build_object(
        'currency',c.currency,
        'period_debits',coalesce((select sum(debit) from p where currency=c.currency),0),
        'period_credits',coalesce((select sum(credit) from p where currency=c.currency),0),
        'revenue',coalesce((select sum(credit-debit) from p where currency=c.currency and account_type='income'),0),
        'expenses',coalesce((select sum(debit-credit) from p where currency=c.currency and account_type='expense'),0),
        'net_profit',coalesce((select sum(credit-debit) from p where currency=c.currency and account_type='income'),0)
          -coalesce((select sum(debit-credit) from p where currency=c.currency and account_type='expense'),0),
        'assets',coalesce((select sum(debit-credit) from a where currency=c.currency and account_type='asset'),0),
        'liabilities',coalesce((select sum(credit-debit) from a where currency=c.currency and account_type='liability'),0),
        'equity',coalesce((select sum(credit-debit) from a where currency=c.currency and account_type='equity'),0),
        'current_earnings',coalesce((select sum(credit-debit) from a where currency=c.currency and account_type='income'),0)
          -coalesce((select sum(debit-credit) from a where currency=c.currency and account_type='expense'),0)
      ) order by c.currency) from currencies c
    ),'[]'::jsonb),
    'trial_balance',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.account_code,x.currency) from(
        select account_id,account_code,account_name,account_type,normal_balance,currency,
          round(sum(debit),2) as debit,round(sum(credit),2) as credit,
          round(case when normal_balance='debit' then sum(debit-credit) else sum(credit-debit) end,2) as balance
        from private.accounting_source_lines(v_org,v_branch,'2000-01-01'::date,p_to)
        group by account_id,account_code,account_name,account_type,normal_balance,currency
        having abs(sum(debit-credit))>0.004
      ) x
    ),'[]'::jsonb),
    'profit_loss',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.account_type desc,x.account_code,x.currency) from(
        select account_id,account_code,account_name,account_type,currency,
          round(case when account_type='income' then sum(credit-debit) else sum(debit-credit) end,2) as amount
        from private.accounting_source_lines(v_org,v_branch,p_from,p_to)
        where account_type in('income','expense')
        group by account_id,account_code,account_name,account_type,currency
        having abs(sum(debit-credit))>0.004
      ) x
    ),'[]'::jsonb),
    'ledger',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.entry_date desc,x.source_number,x.account_code) from(
        select * from private.accounting_source_lines(v_org,v_branch,p_from,p_to)
        order by entry_date desc,source_number,account_code limit 10000
      ) x
    ),'[]'::jsonb),
    'generated_at',now()
  );
end $$;

-- ----------------------------------------------------------------------------
-- 8. GRANTS
-- ----------------------------------------------------------------------------

revoke all on function public.save_accounting_account(uuid,text,text,text,text,boolean,text) from public,anon;
revoke all on function public.save_accounting_mapping(text,uuid) from public,anon;
revoke all on function public.save_manual_journal(uuid,uuid,date,public.currency_code,text,text,text,jsonb) from public,anon;
revoke all on function public.void_manual_journal(uuid,text) from public,anon;
revoke all on function public.set_accounting_period_status(uuid,integer,integer,text,text) from public,anon;
revoke all on function public.get_accounting_workspace() from public,anon;
revoke all on function public.get_accounting_report(date,date,uuid) from public,anon;

grant execute on function public.save_accounting_account(uuid,text,text,text,text,boolean,text) to authenticated;
grant execute on function public.save_accounting_mapping(text,uuid) to authenticated;
grant execute on function public.save_manual_journal(uuid,uuid,date,public.currency_code,text,text,text,jsonb) to authenticated;
grant execute on function public.void_manual_journal(uuid,text) to authenticated;
grant execute on function public.set_accounting_period_status(uuid,integer,integer,text,text) to authenticated;
grant execute on function public.get_accounting_workspace() to authenticated;
grant execute on function public.get_accounting_report(date,date,uuid) to authenticated;

commit;
