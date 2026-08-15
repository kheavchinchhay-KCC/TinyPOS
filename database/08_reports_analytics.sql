-- ============================================================================
-- Tiny POS - Step 10: Reports and analytics
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

alter table public.app_settings
  add column if not exists timezone text not null default 'Asia/Phnom_Penh';

create index if not exists sales_branch_completed_report_idx
  on public.sales (organization_id, branch_id, completed_at desc)
  where status in ('completed', 'partially_refunded', 'refunded');

create index if not exists returns_branch_processed_report_idx
  on public.returns (organization_id, branch_id, processed_at desc)
  where status = 'completed';

create index if not exists purchases_branch_received_report_idx
  on public.purchases (organization_id, branch_id, received_at desc)
  where status = 'received';

create index if not exists payments_branch_paid_report_idx
  on public.payments (organization_id, branch_id, paid_at desc);

create or replace function private.convert_to_base_currency(
  p_amount numeric,
  p_currency public.currency_code,
  p_base_currency public.currency_code,
  p_usd_to_khr_rate numeric
)
returns numeric
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select round(
    case
      when p_amount is null then 0
      when p_currency = p_base_currency then p_amount
      when p_base_currency = 'USD' and p_currency = 'KHR'
        then p_amount / nullif(p_usd_to_khr_rate, 0)
      when p_base_currency = 'KHR' and p_currency = 'USD'
        then p_amount * p_usd_to_khr_rate
      else p_amount
    end,
    case when p_base_currency = 'KHR' then 0 else 2 end
  )
$$;

revoke all on function private.convert_to_base_currency(
  numeric,
  public.currency_code,
  public.currency_code,
  numeric
) from public;

grant execute on function private.convert_to_base_currency(
  numeric,
  public.currency_code,
  public.currency_code,
  numeric
) to authenticated, service_role;

create or replace function public.get_reports_data(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_all_branches boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_branch_id uuid;
  v_branch_name text;
  v_all_branches boolean := false;
  v_can_all_branches boolean := false;
  v_base_currency public.currency_code;
  v_usd_to_khr_rate numeric(14,4);
  v_timezone text;
  v_granularity text;

  v_summary jsonb;
  v_trend jsonb;
  v_payment_methods jsonb;
  v_top_products jsonb;
  v_top_categories jsonb;
  v_cashiers jsonb;
  v_sales_rows jsonb;
  v_purchase_rows jsonb;
  v_top_suppliers jsonb;
  v_stock_summary jsonb;
  v_stock_age jsonb;
  v_stock_rows jsonb;
  v_customer_summary jsonb;
  v_top_customers jsonb;
  v_customer_types jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    p.organization_id,
    p.branch_id,
    p.role,
    p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  perform private.require_permission('reports.view');
  v_can_all_branches := private.has_permission('branches.all');

  if p_from is null or p_to is null then
    raise exception 'A report start date and end date are required';
  end if;

  if p_from > p_to then
    raise exception 'The start date cannot be after the end date';
  end if;

  if (p_to - p_from) > 1095 then
    raise exception 'Choose a report period of three years or less';
  end if;

  select
    s.base_currency,
    s.usd_to_khr_rate,
    coalesce(nullif(trim(s.timezone), ''), 'Asia/Phnom_Penh')
  into
    v_base_currency,
    v_usd_to_khr_rate,
    v_timezone
  from public.app_settings s
  where s.organization_id = v_profile.organization_id;

  if v_base_currency is null then
    v_base_currency := 'USD';
  end if;

  if v_usd_to_khr_rate is null or v_usd_to_khr_rate <= 0 then
    v_usd_to_khr_rate := 4100;
  end if;

  if v_can_all_branches and p_all_branches then
    v_all_branches := true;
    v_branch_id := null;
    v_branch_name := 'All branches';
  else
    v_branch_id := coalesce(p_branch_id, v_profile.branch_id);

    if not v_can_all_branches
       and v_branch_id is distinct from v_profile.branch_id then
      raise exception 'You may report only your assigned branch';
    end if;

    select b.name
    into v_branch_name
    from public.branches b
    where b.id = v_branch_id
      and b.organization_id = v_profile.organization_id;

    if v_branch_name is null then
      raise exception 'Report branch not found';
    end if;
  end if;

  v_granularity := case
    when (p_to - p_from) <= 92 then 'day'
    else 'month'
  end;

  -- --------------------------------------------------------------------------
  -- Summary and profit figures
  -- --------------------------------------------------------------------------
  with report_sales as (
    select
      s.id,
      private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as total_base,
      private.convert_to_base_currency(
        s.subtotal, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as subtotal_base,
      private.convert_to_base_currency(
        s.discount_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as discount_base,
      private.convert_to_base_currency(
        s.tax_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as tax_base,
      private.convert_to_base_currency(
        s.cost_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as cost_base,
      private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as profit_base
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
  ),
  report_returns as (
    select
      private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as refund_base,
      private.convert_to_base_currency(
        r.tax_refund, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as tax_refund_base,
      private.convert_to_base_currency(
        r.cost_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as cost_return_base,
      private.convert_to_base_currency(
        r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as profit_reversal_base
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  ),
  report_purchases as (
    select
      private.convert_to_base_currency(
        p.total_amount, p.currency, v_base_currency, v_usd_to_khr_rate
      ) as purchase_base,
      private.convert_to_base_currency(
        p.amount_paid, p.currency, v_base_currency, v_usd_to_khr_rate
      ) as paid_base
    from public.purchases p
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.status = 'received'
      and (timezone(v_timezone, coalesce(p.received_at, p.created_at)))::date
        between p_from and p_to
  ),
  sold_units as (
    select coalesce(sum(si.quantity), 0) as quantity
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
  ),
  returned_units as (
    select coalesce(sum(ri.quantity), 0) as quantity
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  )
  select jsonb_build_object(
    'gross_sales', coalesce((select sum(total_base) from report_sales), 0),
    'subtotal', coalesce((select sum(subtotal_base) from report_sales), 0),
    'discounts', coalesce((select sum(discount_base) from report_sales), 0),
    'tax_collected', coalesce((select sum(tax_base) from report_sales), 0),
    'refunds', coalesce((select sum(refund_base) from report_returns), 0),
    'tax_refunded', coalesce((select sum(tax_refund_base) from report_returns), 0),
    'net_sales',
      coalesce((select sum(total_base) from report_sales), 0)
      - coalesce((select sum(refund_base) from report_returns), 0),
    'gross_cogs', coalesce((select sum(cost_base) from report_sales), 0),
    'returned_cogs', coalesce((select sum(cost_return_base) from report_returns), 0),
    'net_cogs',
      coalesce((select sum(cost_base) from report_sales), 0)
      - coalesce((select sum(cost_return_base) from report_returns), 0),
    'gross_profit_before_refunds',
      coalesce((select sum(profit_base) from report_sales), 0),
    'profit_reversal',
      coalesce((select sum(profit_reversal_base) from report_returns), 0),
    'gross_profit',
      coalesce((select sum(profit_base) from report_sales), 0)
      - coalesce((select sum(profit_reversal_base) from report_returns), 0),
    'gross_margin_percent',
      case
        when (
          coalesce((select sum(total_base) from report_sales), 0)
          - coalesce((select sum(refund_base) from report_returns), 0)
        ) > 0
        then round(
          (
            coalesce((select sum(profit_base) from report_sales), 0)
            - coalesce((select sum(profit_reversal_base) from report_returns), 0)
          ) * 100
          / (
            coalesce((select sum(total_base) from report_sales), 0)
            - coalesce((select sum(refund_base) from report_returns), 0)
          ),
          2
        )
        else 0
      end,
    'sale_count', (select count(*) from report_sales),
    'refund_count', (select count(*) from report_returns),
    'average_sale',
      case
        when (select count(*) from report_sales) > 0
        then round(
          (
            coalesce((select sum(total_base) from report_sales), 0)
            - coalesce((select sum(refund_base) from report_returns), 0)
          ) / (select count(*) from report_sales),
          2
        )
        else 0
      end,
    'units_sold', coalesce((select quantity from sold_units), 0),
    'units_returned', coalesce((select quantity from returned_units), 0),
    'net_units',
      coalesce((select quantity from sold_units), 0)
      - coalesce((select quantity from returned_units), 0),
    'purchase_total', coalesce((select sum(purchase_base) from report_purchases), 0),
    'purchase_paid', coalesce((select sum(paid_base) from report_purchases), 0),
    'purchase_count', (select count(*) from report_purchases)
  ) into v_summary;

  -- --------------------------------------------------------------------------
  -- Sales/refunds/profit trend
  -- --------------------------------------------------------------------------
  with periods as (
    select generate_series(
      date_trunc(v_granularity, p_from::timestamp),
      date_trunc(v_granularity, p_to::timestamp),
      case when v_granularity = 'day' then interval '1 day' else interval '1 month' end
    )::date as period
  ),
  sales_by_period as (
    select
      date_trunc(
        v_granularity,
        timezone(v_timezone, coalesce(s.completed_at, s.created_at))
      )::date as period,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_sales,
      sum(private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_profit,
      count(*) as sale_count
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by 1
  ),
  returns_by_period as (
    select
      date_trunc(v_granularity, timezone(v_timezone, r.processed_at))::date as period,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds,
      sum(private.convert_to_base_currency(
        r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as profit_reversal,
      count(*) as refund_count
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'period', to_char(p.period, 'YYYY-MM-DD'),
      'gross_sales', coalesce(s.gross_sales, 0),
      'refunds', coalesce(r.refunds, 0),
      'net_sales', coalesce(s.gross_sales, 0) - coalesce(r.refunds, 0),
      'gross_profit', coalesce(s.gross_profit, 0) - coalesce(r.profit_reversal, 0),
      'sale_count', coalesce(s.sale_count, 0),
      'refund_count', coalesce(r.refund_count, 0)
    ) order by p.period
  ), '[]'::jsonb)
  into v_trend
  from periods p
  left join sales_by_period s on s.period = p.period
  left join returns_by_period r on r.period = p.period;

  -- --------------------------------------------------------------------------
  -- Payment-method performance
  -- --------------------------------------------------------------------------
  with money_flow as (
    select
      p.method::text as method,
      private.convert_to_base_currency(
        p.amount, p.currency, v_base_currency, v_usd_to_khr_rate
      ) as collected,
      0::numeric as refunded,
      1 as payment_count,
      0 as refund_count
    from public.payments p
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and (timezone(v_timezone, p.paid_at))::date between p_from and p_to

    union all

    select
      coalesce(r.refund_method::text, 'other') as method,
      0::numeric as collected,
      private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as refunded,
      0 as payment_count,
      1 as refund_count
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'method', method,
      'collected', collected,
      'refunded', refunded,
      'net', collected - refunded,
      'payment_count', payment_count,
      'refund_count', refund_count
    ) order by collected - refunded desc
  ), '[]'::jsonb)
  into v_payment_methods
  from (
    select
      method,
      round(sum(collected), 2) as collected,
      round(sum(refunded), 2) as refunded,
      sum(payment_count) as payment_count,
      sum(refund_count) as refund_count
    from money_flow
    group by method
  ) q;

  -- --------------------------------------------------------------------------
  -- Top products
  -- --------------------------------------------------------------------------
  with sold as (
    select
      coalesce(si.product_id::text, 'name:' || lower(si.product_name)) as item_key,
      max(si.product_id::text)::uuid as product_id,
      max(si.product_name) as product_name,
      sum(si.quantity) as sold_quantity,
      sum(private.convert_to_base_currency(
        si.line_total, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as sold_revenue,
      sum(private.convert_to_base_currency(
        si.line_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as sold_profit
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by 1
  ),
  refunded as (
    select
      coalesce(ri.product_id::text, 'name:' || lower(si.product_name)) as item_key,
      max(ri.product_id::text)::uuid as product_id,
      max(si.product_name) as product_name,
      sum(ri.quantity) as returned_quantity,
      sum(private.convert_to_base_currency(
        ri.line_refund - ri.tax_refund,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as returned_revenue,
      sum(private.convert_to_base_currency(
        ri.line_profit_reversal,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as returned_profit
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    join public.sale_items si on si.id = ri.sale_item_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'sold_quantity', sold_quantity,
      'returned_quantity', returned_quantity,
      'net_quantity', sold_quantity - returned_quantity,
      'gross_revenue', sold_revenue,
      'refund_revenue', returned_revenue,
      'net_revenue', sold_revenue - returned_revenue,
      'gross_profit', sold_profit - returned_profit
    ) order by sold_revenue - returned_revenue desc
  ), '[]'::jsonb)
  into v_top_products
  from (
    select
      coalesce(s.item_key, r.item_key) as item_key,
      coalesce(s.product_id, r.product_id) as product_id,
      coalesce(s.product_name, r.product_name) as product_name,
      coalesce(s.sold_quantity, 0) as sold_quantity,
      coalesce(r.returned_quantity, 0) as returned_quantity,
      coalesce(s.sold_revenue, 0) as sold_revenue,
      coalesce(r.returned_revenue, 0) as returned_revenue,
      coalesce(s.sold_profit, 0) as sold_profit,
      coalesce(r.returned_profit, 0) as returned_profit
    from sold s
    full join refunded r on r.item_key = s.item_key
    order by coalesce(s.sold_revenue, 0) - coalesce(r.returned_revenue, 0) desc
    limit 15
  ) q;

  -- --------------------------------------------------------------------------
  -- Top categories
  -- --------------------------------------------------------------------------
  with category_sales as (
    select
      coalesce(c.id::text, 'uncategorized') as category_key,
      coalesce(max(c.name), 'Uncategorized') as category_name,
      sum(si.quantity) as sold_quantity,
      sum(private.convert_to_base_currency(
        si.line_total, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as sold_revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    left join public.products p on p.id = si.product_id
    left join public.categories c on c.id = p.category_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by 1
  ),
  category_returns as (
    select
      coalesce(c.id::text, 'uncategorized') as category_key,
      coalesce(max(c.name), 'Uncategorized') as category_name,
      sum(ri.quantity) as returned_quantity,
      sum(private.convert_to_base_currency(
        ri.line_refund - ri.tax_refund,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as returned_revenue
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    left join public.products p on p.id = ri.product_id
    left join public.categories c on c.id = p.category_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'category_name', category_name,
      'sold_quantity', sold_quantity,
      'returned_quantity', returned_quantity,
      'net_quantity', sold_quantity - returned_quantity,
      'net_revenue', sold_revenue - returned_revenue
    ) order by sold_revenue - returned_revenue desc
  ), '[]'::jsonb)
  into v_top_categories
  from (
    select
      coalesce(s.category_key, r.category_key) as category_key,
      coalesce(s.category_name, r.category_name) as category_name,
      coalesce(s.sold_quantity, 0) as sold_quantity,
      coalesce(r.returned_quantity, 0) as returned_quantity,
      coalesce(s.sold_revenue, 0) as sold_revenue,
      coalesce(r.returned_revenue, 0) as returned_revenue
    from category_sales s
    full join category_returns r on r.category_key = s.category_key
    order by coalesce(s.sold_revenue, 0) - coalesce(r.returned_revenue, 0) desc
    limit 12
  ) q;

  -- --------------------------------------------------------------------------
  -- Cashier performance
  -- --------------------------------------------------------------------------
  with cashier_sales as (
    select
      s.cashier_id,
      max(coalesce(p.full_name, p.email, 'POS Staff')) as cashier_name,
      count(*) as sale_count,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_sales,
      sum(private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_profit
    from public.sales s
    left join public.profiles p on p.id = s.cashier_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by s.cashier_id
  ),
  cashier_returns as (
    select
      s.cashier_id,
      count(*) as refund_count,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds,
      sum(private.convert_to_base_currency(
        r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as profit_reversal
    from public.returns r
    join public.sales s on s.id = r.original_sale_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by s.cashier_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'cashier_id', s.cashier_id,
      'cashier_name', s.cashier_name,
      'sale_count', s.sale_count,
      'refund_count', coalesce(r.refund_count, 0),
      'gross_sales', s.gross_sales,
      'refunds', coalesce(r.refunds, 0),
      'net_sales', s.gross_sales - coalesce(r.refunds, 0),
      'gross_profit', s.gross_profit - coalesce(r.profit_reversal, 0)
    ) order by s.gross_sales - coalesce(r.refunds, 0) desc
  ), '[]'::jsonb)
  into v_cashiers
  from cashier_sales s
  left join cashier_returns r on r.cashier_id = s.cashier_id;

  -- --------------------------------------------------------------------------
  -- Invoice-level rows for the detailed sales table and CSV export
  -- --------------------------------------------------------------------------
  select coalesce(jsonb_agg(row_data order by completed_at desc), '[]'::jsonb)
  into v_sales_rows
  from (
    select jsonb_build_object(
      'invoice_number', s.invoice_number,
      'completed_at', coalesce(s.completed_at, s.created_at),
      'branch_name', b.name,
      'customer_name', coalesce(c.name, 'Walk-in'),
      'cashier_name', coalesce(pr.full_name, pr.email, 'POS Staff'),
      'payment_methods', coalesce(pay.methods, '—'),
      'currency', s.currency,
      'gross_total', private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ),
      'refund_total', coalesce(ref.refund_total, 0),
      'net_total', private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) - coalesce(ref.refund_total, 0),
      'cost', private.convert_to_base_currency(
        s.cost_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) - coalesce(ref.cost_return, 0),
      'gross_profit', private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      ) - coalesce(ref.profit_reversal, 0),
      'status', s.status
    ) as row_data,
    coalesce(s.completed_at, s.created_at) as completed_at
    from public.sales s
    join public.branches b on b.id = s.branch_id
    left join public.customers c on c.id = s.customer_id
    left join public.profiles pr on pr.id = s.cashier_id
    left join lateral (
      select string_agg(distinct upper(p.method::text), ', ' order by upper(p.method::text)) as methods
      from public.payments p
      where p.sale_id = s.id
    ) pay on true
    left join lateral (
      select
        sum(private.convert_to_base_currency(
          r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
        )) as refund_total,
        sum(private.convert_to_base_currency(
          r.cost_amount, r.currency, v_base_currency, v_usd_to_khr_rate
        )) as cost_return,
        sum(private.convert_to_base_currency(
          r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
        )) as profit_reversal
      from public.returns r
      where r.original_sale_id = s.id
        and r.status = 'completed'
    ) ref on true
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    order by coalesce(s.completed_at, s.created_at) desc
    limit 500
  ) rows;

  -- --------------------------------------------------------------------------
  -- Purchases and suppliers
  -- --------------------------------------------------------------------------
  select coalesce(jsonb_agg(row_data order by received_at desc), '[]'::jsonb)
  into v_purchase_rows
  from (
    select
      jsonb_build_object(
        'purchase_number', p.purchase_number,
        'received_at', coalesce(p.received_at, p.created_at),
        'branch_name', b.name,
        'supplier_name', coalesce(s.name, 'No supplier'),
        'supplier_invoice_number', p.supplier_invoice_number,
        'total', private.convert_to_base_currency(
          p.total_amount, p.currency, v_base_currency, v_usd_to_khr_rate
        ),
        'amount_paid', private.convert_to_base_currency(
          p.amount_paid, p.currency, v_base_currency, v_usd_to_khr_rate
        ),
        'balance', private.convert_to_base_currency(
          greatest(p.total_amount - p.amount_paid, 0),
          p.currency,
          v_base_currency,
          v_usd_to_khr_rate
        ),
        'status', p.status
      ) as row_data,
      coalesce(p.received_at, p.created_at) as received_at
    from public.purchases p
    join public.branches b on b.id = p.branch_id
    left join public.suppliers s on s.id = p.supplier_id
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.status = 'received'
      and (timezone(v_timezone, coalesce(p.received_at, p.created_at)))::date
        between p_from and p_to
    order by coalesce(p.received_at, p.created_at) desc
    limit 500
  ) rows;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'supplier_name', supplier_name,
      'purchase_count', purchase_count,
      'purchase_total', purchase_total,
      'amount_paid', amount_paid,
      'balance', purchase_total - amount_paid
    ) order by purchase_total desc
  ), '[]'::jsonb)
  into v_top_suppliers
  from (
    select
      coalesce(s.name, 'No supplier') as supplier_name,
      count(*) as purchase_count,
      sum(private.convert_to_base_currency(
        p.total_amount, p.currency, v_base_currency, v_usd_to_khr_rate
      )) as purchase_total,
      sum(private.convert_to_base_currency(
        p.amount_paid, p.currency, v_base_currency, v_usd_to_khr_rate
      )) as amount_paid
    from public.purchases p
    left join public.suppliers s on s.id = p.supplier_id
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.status = 'received'
      and (timezone(v_timezone, coalesce(p.received_at, p.created_at)))::date
        between p_from and p_to
    group by coalesce(s.name, 'No supplier')
    order by purchase_total desc
    limit 15
  ) q;

  -- --------------------------------------------------------------------------
  -- Current stock and last-inbound-age analysis
  -- This is not FIFO batch aging. It classifies current stock using the latest
  -- positive stock movement for each product and branch.
  -- --------------------------------------------------------------------------
  with selected_branches as (
    select b.id, b.name
    from public.branches b
    where b.organization_id = v_profile.organization_id
      and b.is_active = true
      and (v_all_branches or b.id = v_branch_id)
  ),
  stock_detail as (
    select
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.barcode,
      coalesce(c.name, 'Uncategorized') as category_name,
      sb.id as branch_id,
      sb.name as branch_name,
      p.currency,
      p.selling_price,
      coalesce(ib.quantity, 0) as quantity,
      coalesce(nullif(ib.average_cost, 0), p.default_cost, 0) as average_cost,
      coalesce(p.low_stock_threshold, settings.low_stock_threshold, 0) as low_stock_threshold,
      coalesce(last_in.last_inbound_at, p.created_at) as last_inbound_at,
      greatest(
        p_to - (timezone(v_timezone, coalesce(last_in.last_inbound_at, p.created_at)))::date,
        0
      ) as age_days
    from public.products p
    cross join selected_branches sb
    left join public.categories c on c.id = p.category_id
    left join public.inventory_balances ib
      on ib.product_id = p.id
      and ib.branch_id = sb.id
    join public.app_settings settings
      on settings.organization_id = p.organization_id
    left join lateral (
      select max(sm.created_at) as last_inbound_at
      from public.stock_movements sm
      where sm.product_id = p.id
        and sm.branch_id = sb.id
        and sm.quantity_change > 0
    ) last_in on true
    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
  ),
  valued_stock as (
    select
      *,
      private.convert_to_base_currency(
        quantity * average_cost,
        currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as cost_value,
      private.convert_to_base_currency(
        quantity * selling_price,
        currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as retail_value
    from stock_detail
  )
  select jsonb_build_object(
    'product_count', count(distinct product_id),
    'stock_units', coalesce(sum(quantity), 0),
    'stock_cost_value', coalesce(sum(cost_value), 0),
    'stock_retail_value', coalesce(sum(retail_value), 0),
    'potential_margin', coalesce(sum(retail_value - cost_value), 0),
    'low_stock_count', count(*) filter (
      where quantity > 0 and quantity <= low_stock_threshold
    ),
    'out_of_stock_count', count(*) filter (where quantity <= 0),
    'negative_stock_count', count(*) filter (where quantity < 0)
  )
  into v_stock_summary
  from valued_stock;

  with selected_branches as (
    select b.id
    from public.branches b
    where b.organization_id = v_profile.organization_id
      and b.is_active = true
      and (v_all_branches or b.id = v_branch_id)
  ),
  aged as (
    select
      p.id as product_id,
      coalesce(ib.quantity, 0) as quantity,
      private.convert_to_base_currency(
        coalesce(ib.quantity, 0)
          * coalesce(nullif(ib.average_cost, 0), p.default_cost, 0),
        p.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as cost_value,
      greatest(
        p_to - (timezone(
          v_timezone,
          coalesce(last_in.last_inbound_at, p.created_at)
        ))::date,
        0
      ) as age_days
    from public.products p
    cross join selected_branches sb
    left join public.inventory_balances ib
      on ib.product_id = p.id and ib.branch_id = sb.id
    left join lateral (
      select max(sm.created_at) as last_inbound_at
      from public.stock_movements sm
      where sm.product_id = p.id
        and sm.branch_id = sb.id
        and sm.quantity_change > 0
    ) last_in on true
    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
      and coalesce(ib.quantity, 0) > 0
  ),
  buckets(bucket_order, bucket, min_days, max_days) as (
    values
      (1, '0–30 days', 0, 30),
      (2, '31–60 days', 31, 60),
      (3, '61–90 days', 61, 90),
      (4, '91+ days', 91, 1000000)
  ),
  bucket_totals as (
    select
      b.bucket_order,
      b.bucket,
      count(a.product_id) as product_count,
      coalesce(sum(a.quantity), 0) as quantity,
      coalesce(sum(a.cost_value), 0) as stock_value
    from buckets b
    left join aged a
      on a.age_days between b.min_days and b.max_days
    group by b.bucket_order, b.bucket
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'bucket', bucket,
      'product_count', product_count,
      'quantity', quantity,
      'stock_value', stock_value
    ) order by bucket_order
  ), '[]'::jsonb)
  into v_stock_age
  from bucket_totals;

  with selected_branches as (
    select b.id
    from public.branches b
    where b.organization_id = v_profile.organization_id
      and b.is_active = true
      and (v_all_branches or b.id = v_branch_id)
  ),
  detail as (
    select
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.barcode,
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(coalesce(ib.quantity, 0)) as quantity,
      sum(private.convert_to_base_currency(
        coalesce(ib.quantity, 0)
          * coalesce(nullif(ib.average_cost, 0), p.default_cost, 0),
        p.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as cost_value,
      sum(private.convert_to_base_currency(
        coalesce(ib.quantity, 0) * p.selling_price,
        p.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as retail_value,
      max(coalesce(last_in.last_inbound_at, p.created_at)) as last_inbound_at,
      min(greatest(
        p_to - (timezone(
          v_timezone,
          coalesce(last_in.last_inbound_at, p.created_at)
        ))::date,
        0
      )) as age_days,
      max(coalesce(p.low_stock_threshold, settings.low_stock_threshold, 0)) as low_stock_threshold
    from public.products p
    cross join selected_branches sb
    left join public.categories c on c.id = p.category_id
    left join public.inventory_balances ib
      on ib.product_id = p.id and ib.branch_id = sb.id
    join public.app_settings settings
      on settings.organization_id = p.organization_id
    left join lateral (
      select max(sm.created_at) as last_inbound_at
      from public.stock_movements sm
      where sm.product_id = p.id
        and sm.branch_id = sb.id
        and sm.quantity_change > 0
    ) last_in on true
    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
    group by p.id, p.name, p.sku, p.barcode, c.name
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'sku', sku,
      'barcode', barcode,
      'category_name', category_name,
      'quantity', quantity,
      'cost_value', cost_value,
      'retail_value', retail_value,
      'potential_margin', retail_value - cost_value,
      'last_inbound_at', last_inbound_at,
      'age_days', age_days,
      'low_stock_threshold', low_stock_threshold,
      'stock_status', case
        when quantity < 0 then 'negative'
        when quantity = 0 then 'out'
        when quantity <= low_stock_threshold then 'low'
        else 'ok'
      end
    ) order by cost_value desc, product_name
  ), '[]'::jsonb)
  into v_stock_rows
  from (
    select *
    from detail
    order by cost_value desc, product_name
    limit 1000
  ) q;

  -- --------------------------------------------------------------------------
  -- Customer analysis
  -- --------------------------------------------------------------------------
  with customer_sales as (
    select
      s.customer_id,
      count(*) as sale_count,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_spend,
      max(coalesce(s.completed_at, s.created_at)) as last_purchase
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.customer_id is not null
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by s.customer_id
  ),
  customer_returns as (
    select
      r.customer_id,
      count(*) as refund_count,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.customer_id is not null
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by r.customer_id
  )
  select jsonb_build_object(
    'total_customers', (
      select count(*) from public.customers c
      where c.organization_id = v_profile.organization_id
    ),
    'active_customers', (
      select count(*) from public.customers c
      where c.organization_id = v_profile.organization_id
        and c.is_active = true
    ),
    'new_customers', (
      select count(*) from public.customers c
      where c.organization_id = v_profile.organization_id
        and (timezone(v_timezone, c.created_at))::date between p_from and p_to
    ),
    'customers_with_sales', (select count(*) from customer_sales),
    'repeat_customers', (
      select count(*) from customer_sales where sale_count >= 2
    ),
    'loyalty_points_outstanding', (
      select coalesce(sum(c.loyalty_points), 0)
      from public.customers c
      where c.organization_id = v_profile.organization_id
        and c.is_active = true
    ),
    'customer_gross_spend', coalesce((select sum(gross_spend) from customer_sales), 0),
    'customer_refunds', coalesce((select sum(refunds) from customer_returns), 0),
    'customer_net_spend',
      coalesce((select sum(gross_spend) from customer_sales), 0)
      - coalesce((select sum(refunds) from customer_returns), 0)
  ) into v_customer_summary;

  with customer_sales as (
    select
      s.customer_id,
      count(*) as sale_count,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_spend,
      max(coalesce(s.completed_at, s.created_at)) as last_purchase
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.customer_id is not null
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by s.customer_id
  ),
  customer_returns as (
    select
      r.customer_id,
      count(*) as refund_count,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.customer_id is not null
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by r.customer_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'customer_id', customer_id,
      'customer_code', customer_code,
      'customer_name', customer_name,
      'customer_type', customer_type,
      'phone', phone,
      'sale_count', sale_count,
      'refund_count', refund_count,
      'gross_spend', gross_spend,
      'refunds', refunds,
      'net_spend', net_spend,
      'average_sale', average_sale,
      'last_purchase', last_purchase,
      'loyalty_points', loyalty_points
    ) order by net_spend desc
  ), '[]'::jsonb)
  into v_top_customers
  from (
    select
      c.id as customer_id,
      c.customer_code,
      c.name as customer_name,
      c.customer_type,
      c.phone,
      s.sale_count,
      coalesce(r.refund_count, 0) as refund_count,
      s.gross_spend,
      coalesce(r.refunds, 0) as refunds,
      s.gross_spend - coalesce(r.refunds, 0) as net_spend,
      case
        when s.sale_count > 0 then round(s.gross_spend / s.sale_count, 2)
        else 0
      end as average_sale,
      s.last_purchase,
      c.loyalty_points
    from customer_sales s
    join public.customers c on c.id = s.customer_id
    left join customer_returns r on r.customer_id = s.customer_id
    order by s.gross_spend - coalesce(r.refunds, 0) desc
    limit 20
  ) ranked_customers;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'customer_type', customer_type,
      'customer_count', customer_count,
      'loyalty_points', loyalty_points
    ) order by customer_count desc
  ), '[]'::jsonb)
  into v_customer_types
  from (
    select
      c.customer_type,
      count(*) as customer_count,
      coalesce(sum(c.loyalty_points), 0) as loyalty_points
    from public.customers c
    where c.organization_id = v_profile.organization_id
      and c.is_active = true
    group by c.customer_type
  ) q;

  return jsonb_build_object(
    'generated_at', now(),
    'from', p_from,
    'to', p_to,
    'timezone', v_timezone,
    'base_currency', v_base_currency,
    'usd_to_khr_rate', v_usd_to_khr_rate,
    'granularity', v_granularity,
    'scope', jsonb_build_object(
      'all_branches', v_all_branches,
      'branch_id', v_branch_id,
      'branch_name', v_branch_name
    ),
    'summary', coalesce(v_summary, '{}'::jsonb),
    'trend', coalesce(v_trend, '[]'::jsonb),
    'payment_methods', coalesce(v_payment_methods, '[]'::jsonb),
    'top_products', coalesce(v_top_products, '[]'::jsonb),
    'top_categories', coalesce(v_top_categories, '[]'::jsonb),
    'cashiers', coalesce(v_cashiers, '[]'::jsonb),
    'sales_rows', coalesce(v_sales_rows, '[]'::jsonb),
    'purchase_rows', coalesce(v_purchase_rows, '[]'::jsonb),
    'top_suppliers', coalesce(v_top_suppliers, '[]'::jsonb),
    'stock_summary', coalesce(v_stock_summary, '{}'::jsonb),
    'stock_age', coalesce(v_stock_age, '[]'::jsonb),
    'stock_rows', coalesce(v_stock_rows, '[]'::jsonb),
    'customer_summary', coalesce(v_customer_summary, '{}'::jsonb),
    'top_customers', coalesce(v_top_customers, '[]'::jsonb),
    'customer_types', coalesce(v_customer_types, '[]'::jsonb),
    'stock_age_note', 'Stock age uses the latest positive stock movement for each product and branch. It is not FIFO batch aging.'
  );
end;
$$;

revoke all on function public.get_reports_data(
  date,
  date,
  uuid,
  boolean
) from public, anon;

grant execute on function public.get_reports_data(
  date,
  date,
  uuid,
  boolean
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 10
-- ============================================================================
