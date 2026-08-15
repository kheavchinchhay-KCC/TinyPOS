-- ============================================================================
-- Tiny POS - Step 21: Dashboard and Action Center
-- Run once in the NEW Supabase project after Step 20.
--
-- Adds one secure dashboard RPC. It does not create or delete business data.
-- ============================================================================

begin;

create or replace function public.get_dashboard_action_center(
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

  v_all_branches boolean := false;
  v_branch_id uuid;
  v_branch_name text;

  v_base_currency public.currency_code := 'USD';
  v_usd_to_khr_rate numeric(14,4) := 4100;
  v_timezone text := 'Asia/Phnom_Penh';

  v_today date;
  v_week_start date;
  v_month_start date;
  v_previous_month_start date;
  v_previous_month_end date;
  v_trend_start date;

  v_can_view_profit boolean := false;
  v_can_view_all_branches boolean := false;

  v_today_summary jsonb := '{}'::jsonb;
  v_period_summary jsonb := '{}'::jsonb;
  v_trend jsonb := '[]'::jsonb;
  v_payment_methods jsonb := '[]'::jsonb;
  v_top_products jsonb := '[]'::jsonb;
  v_recent_sales jsonb := '[]'::jsonb;
  v_branch_performance jsonb := '[]'::jsonb;
  v_quick_counts jsonb := '{}'::jsonb;
  v_register jsonb := '{}'::jsonb;
  v_alerts jsonb := '[]'::jsonb;

  v_out_of_stock integer := 0;
  v_low_stock integer := 0;
  v_pending_transfers integer := 0;
  v_overdue_orders integer := 0;
  v_draft_orders integer := 0;
  v_unpaid_orders integer := 0;
  v_unpaid_balance numeric := 0;
  v_parked_sales integer := 0;
  v_expiring_coupons integer := 0;
  v_register_open boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    p.organization_id,
    p.branch_id,
    p.role,
    p.is_active,
    p.full_name
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.branch_id is null then
    raise exception 'No branch is assigned to this user';
  end if;

  v_can_view_profit :=
    v_profile.role in ('owner','admin','manager','viewer');

  v_can_view_all_branches :=
    v_profile.role in ('owner','admin');

  if p_all_branches and v_can_view_all_branches then
    v_all_branches := true;
    v_branch_id := null;
    v_branch_name := 'All branches';
  else
    v_all_branches := false;
    v_branch_id := v_profile.branch_id;

    select b.name
    into v_branch_name
    from public.branches b
    where b.id = v_branch_id
      and b.organization_id = v_profile.organization_id;

    if v_branch_name is null then
      raise exception 'Assigned branch not found';
    end if;
  end if;

  select
    coalesce(s.base_currency, 'USD'),
    coalesce(nullif(s.usd_to_khr_rate, 0), 4100),
    coalesce(nullif(trim(s.timezone), ''), 'Asia/Phnom_Penh')
  into
    v_base_currency,
    v_usd_to_khr_rate,
    v_timezone
  from public.app_settings s
  where s.organization_id = v_profile.organization_id;

  v_today := (timezone(v_timezone, now()))::date;
  v_week_start := date_trunc('week', v_today::timestamp)::date;
  v_month_start := date_trunc('month', v_today::timestamp)::date;
  v_previous_month_start :=
    (v_month_start - interval '1 month')::date;
  v_previous_month_end := (v_month_start - interval '1 day')::date;
  v_trend_start := v_today - 6;

  -- --------------------------------------------------------------------------
  -- Today's summary
  -- --------------------------------------------------------------------------

  with today_sales as (
    select
      private.convert_to_base_currency(
        s.total_amount,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as total_base,

      private.convert_to_base_currency(
        s.gross_profit,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as profit_base

    from public.sales s

    where s.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or s.branch_id = v_branch_id
      )
      and s.status in (
        'completed',
        'partially_refunded',
        'refunded'
      )
      and (
        timezone(
          v_timezone,
          coalesce(s.completed_at, s.created_at)
        )
      )::date = v_today
  ),

  today_returns as (
    select
      private.convert_to_base_currency(
        r.refund_amount,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as refund_base,

      private.convert_to_base_currency(
        r.profit_reversal,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as reversal_base

    from public.returns r

    where r.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or r.branch_id = v_branch_id
      )
      and r.status = 'completed'
      and (
        timezone(v_timezone, r.processed_at)
      )::date = v_today
  ),

  today_cash_profit as (
    select
      coalesce(sum(
        case
          when e.direction = 'income'
            then private.convert_to_base_currency(
              e.amount,
              e.currency,
              v_base_currency,
              v_usd_to_khr_rate
            )
          else 0
        end
      ), 0) as other_income,

      coalesce(sum(
        case
          when e.direction = 'expense'
            then private.convert_to_base_currency(
              e.amount,
              e.currency,
              v_base_currency,
              v_usd_to_khr_rate
            )
          else 0
        end
      ), 0) as operating_expenses

    from public.cash_entries e
    join public.cash_categories c
      on c.id = e.category_id

    where e.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or e.branch_id = v_branch_id
      )
      and e.status = 'active'
      and c.affects_profit = true
      and (
        timezone(v_timezone, e.entry_at)
      )::date = v_today
  )

  select jsonb_build_object(
    'gross_sales',
      coalesce((select sum(total_base) from today_sales), 0),

    'refunds',
      coalesce((select sum(refund_base) from today_returns), 0),

    'net_sales',
      coalesce((select sum(total_base) from today_sales), 0)
      - coalesce((select sum(refund_base) from today_returns), 0),

    'sale_count',
      (select count(*) from today_sales),

    'refund_count',
      (select count(*) from today_returns),

    'average_sale',
      case
        when (select count(*) from today_sales) > 0
          then round(
            (
              coalesce(
                (select sum(total_base) from today_sales),
                0
              )
              - coalesce(
                (select sum(refund_base) from today_returns),
                0
              )
            )
            / (select count(*) from today_sales),
            case
              when v_base_currency = 'KHR' then 0
              else 2
            end
          )
        else 0
      end,

    'gross_profit',
      case
        when v_can_view_profit then
          coalesce(
            (select sum(profit_base) from today_sales),
            0
          )
          - coalesce(
            (select sum(reversal_base) from today_returns),
            0
          )
        else null
      end,

    'other_income',
      case
        when v_can_view_profit then
          coalesce(
            (select other_income from today_cash_profit),
            0
          )
        else null
      end,

    'operating_expenses',
      case
        when v_can_view_profit then
          coalesce(
            (select operating_expenses from today_cash_profit),
            0
          )
        else null
      end,

    'net_profit',
      case
        when v_can_view_profit then
          (
            coalesce(
              (select sum(profit_base) from today_sales),
              0
            )
            - coalesce(
              (select sum(reversal_base) from today_returns),
              0
            )
            + coalesce(
              (select other_income from today_cash_profit),
              0
            )
            - coalesce(
              (select operating_expenses from today_cash_profit),
              0
            )
          )
        else null
      end
  )
  into v_today_summary;

  -- --------------------------------------------------------------------------
  -- Week, month and previous-month summary
  -- --------------------------------------------------------------------------

  with period_sales as (
    select
      (
        timezone(
          v_timezone,
          coalesce(s.completed_at, s.created_at)
        )
      )::date as business_date,

      private.convert_to_base_currency(
        s.total_amount,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as total_base,

      private.convert_to_base_currency(
        s.gross_profit,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as profit_base

    from public.sales s

    where s.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or s.branch_id = v_branch_id
      )
      and s.status in (
        'completed',
        'partially_refunded',
        'refunded'
      )
      and (
        timezone(
          v_timezone,
          coalesce(s.completed_at, s.created_at)
        )
      )::date between v_previous_month_start and v_today
  ),

  period_returns as (
    select
      (
        timezone(v_timezone, r.processed_at)
      )::date as business_date,

      private.convert_to_base_currency(
        r.refund_amount,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as refund_base,

      private.convert_to_base_currency(
        r.profit_reversal,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as reversal_base

    from public.returns r

    where r.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or r.branch_id = v_branch_id
      )
      and r.status = 'completed'
      and (
        timezone(v_timezone, r.processed_at)
      )::date between v_previous_month_start and v_today
  ),

  period_cash as (
    select
      (
        timezone(v_timezone, e.entry_at)
      )::date as business_date,

      sum(
        case
          when e.direction = 'income'
            then private.convert_to_base_currency(
              e.amount,
              e.currency,
              v_base_currency,
              v_usd_to_khr_rate
            )
          else 0
        end
      ) as income_base,

      sum(
        case
          when e.direction = 'expense'
            then private.convert_to_base_currency(
              e.amount,
              e.currency,
              v_base_currency,
              v_usd_to_khr_rate
            )
          else 0
        end
      ) as expense_base

    from public.cash_entries e
    join public.cash_categories c
      on c.id = e.category_id

    where e.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or e.branch_id = v_branch_id
      )
      and e.status = 'active'
      and c.affects_profit = true
      and (
        timezone(v_timezone, e.entry_at)
      )::date between v_previous_month_start and v_today

    group by (
      timezone(v_timezone, e.entry_at)
    )::date
  )

  select jsonb_build_object(
    'week_net_sales',
      coalesce((
        select sum(total_base)
        from period_sales
        where business_date between v_week_start and v_today
      ), 0)
      - coalesce((
        select sum(refund_base)
        from period_returns
        where business_date between v_week_start and v_today
      ), 0),

    'week_sale_count',
      (
        select count(*)
        from period_sales
        where business_date between v_week_start and v_today
      ),

    'week_net_profit',
      case
        when v_can_view_profit then
          coalesce((
            select sum(profit_base)
            from period_sales
            where business_date between v_week_start and v_today
          ), 0)
          - coalesce((
            select sum(reversal_base)
            from period_returns
            where business_date between v_week_start and v_today
          ), 0)
          + coalesce((
            select sum(income_base)
            from period_cash
            where business_date between v_week_start and v_today
          ), 0)
          - coalesce((
            select sum(expense_base)
            from period_cash
            where business_date between v_week_start and v_today
          ), 0)
        else null
      end,

    'month_net_sales',
      coalesce((
        select sum(total_base)
        from period_sales
        where business_date between v_month_start and v_today
      ), 0)
      - coalesce((
        select sum(refund_base)
        from period_returns
        where business_date between v_month_start and v_today
      ), 0),

    'month_sale_count',
      (
        select count(*)
        from period_sales
        where business_date between v_month_start and v_today
      ),

    'month_net_profit',
      case
        when v_can_view_profit then
          coalesce((
            select sum(profit_base)
            from period_sales
            where business_date between v_month_start and v_today
          ), 0)
          - coalesce((
            select sum(reversal_base)
            from period_returns
            where business_date between v_month_start and v_today
          ), 0)
          + coalesce((
            select sum(income_base)
            from period_cash
            where business_date between v_month_start and v_today
          ), 0)
          - coalesce((
            select sum(expense_base)
            from period_cash
            where business_date between v_month_start and v_today
          ), 0)
        else null
      end,

    'previous_month_net_sales',
      coalesce((
        select sum(total_base)
        from period_sales
        where business_date
          between v_previous_month_start and v_previous_month_end
      ), 0)
      - coalesce((
        select sum(refund_base)
        from period_returns
        where business_date
          between v_previous_month_start and v_previous_month_end
      ), 0),

    'month_change_percent',
      case
        when (
          coalesce((
            select sum(total_base)
            from period_sales
            where business_date
              between v_previous_month_start and v_previous_month_end
          ), 0)
          - coalesce((
            select sum(refund_base)
            from period_returns
            where business_date
              between v_previous_month_start and v_previous_month_end
          ), 0)
        ) <> 0
        then round(
          (
            (
              coalesce((
                select sum(total_base)
                from period_sales
                where business_date between v_month_start and v_today
              ), 0)
              - coalesce((
                select sum(refund_base)
                from period_returns
                where business_date between v_month_start and v_today
              ), 0)
            )
            -
            (
              coalesce((
                select sum(total_base)
                from period_sales
                where business_date
                  between v_previous_month_start and v_previous_month_end
              ), 0)
              - coalesce((
                select sum(refund_base)
                from period_returns
                where business_date
                  between v_previous_month_start and v_previous_month_end
              ), 0)
            )
          )
          /
          abs(
            (
              coalesce((
                select sum(total_base)
                from period_sales
                where business_date
                  between v_previous_month_start and v_previous_month_end
              ), 0)
              - coalesce((
                select sum(refund_base)
                from period_returns
                where business_date
                  between v_previous_month_start and v_previous_month_end
              ), 0)
            )
          )
          * 100,
          1
        )
        else null
      end
  )
  into v_period_summary;

  -- --------------------------------------------------------------------------
  -- Seven-day sales trend
  -- --------------------------------------------------------------------------

  with days as (
    select generate_series(
      v_trend_start::timestamp,
      v_today::timestamp,
      interval '1 day'
    )::date as business_date
  ),

  daily_sales as (
    select
      (
        timezone(
          v_timezone,
          coalesce(s.completed_at, s.created_at)
        )
      )::date as business_date,

      sum(private.convert_to_base_currency(
        s.total_amount,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as gross_sales,

      sum(private.convert_to_base_currency(
        s.gross_profit,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as gross_profit,

      count(*) as sale_count

    from public.sales s

    where s.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or s.branch_id = v_branch_id
      )
      and s.status in (
        'completed',
        'partially_refunded',
        'refunded'
      )
      and (
        timezone(
          v_timezone,
          coalesce(s.completed_at, s.created_at)
        )
      )::date between v_trend_start and v_today

    group by (
      timezone(
        v_timezone,
        coalesce(s.completed_at, s.created_at)
      )
    )::date
  ),

  daily_returns as (
    select
      (
        timezone(v_timezone, r.processed_at)
      )::date as business_date,

      sum(private.convert_to_base_currency(
        r.refund_amount,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as refunds,

      sum(private.convert_to_base_currency(
        r.profit_reversal,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as profit_reversal

    from public.returns r

    where r.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or r.branch_id = v_branch_id
      )
      and r.status = 'completed'
      and (
        timezone(v_timezone, r.processed_at)
      )::date between v_trend_start and v_today

    group by (
      timezone(v_timezone, r.processed_at)
    )::date
  )

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', d.business_date,
      'gross_sales', coalesce(s.gross_sales, 0),
      'refunds', coalesce(r.refunds, 0),
      'net_sales',
        coalesce(s.gross_sales, 0)
        - coalesce(r.refunds, 0),
      'sale_count', coalesce(s.sale_count, 0),
      'net_profit',
        case
          when v_can_view_profit then
            coalesce(s.gross_profit, 0)
            - coalesce(r.profit_reversal, 0)
          else null
        end
    )
    order by d.business_date
  ), '[]'::jsonb)
  into v_trend
  from days d
  left join daily_sales s
    on s.business_date = d.business_date
  left join daily_returns r
    on r.business_date = d.business_date;

  -- --------------------------------------------------------------------------
  -- Today's payment mix
  -- --------------------------------------------------------------------------

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'method', method,
      'amount', amount,
      'transaction_count', transaction_count,
      'percent',
        case
          when total_amount > 0
            then round(amount / total_amount * 100, 1)
          else 0
        end
    )
    order by amount desc
  ), '[]'::jsonb)
  into v_payment_methods
  from (
    select
      grouped.method,
      grouped.amount,
      grouped.transaction_count,
      sum(grouped.amount) over () as total_amount
    from (
      select
        p.method,
        sum(private.convert_to_base_currency(
          p.amount,
          p.currency,
          v_base_currency,
          v_usd_to_khr_rate
        )) as amount,
        count(*) as transaction_count
      from public.payments p
      where p.organization_id = v_profile.organization_id
        and (
          v_all_branches
          or p.branch_id = v_branch_id
        )
        and (
          timezone(v_timezone, p.paid_at)
        )::date = v_today
      group by p.method
    ) grouped
  ) payment_rows;

  -- --------------------------------------------------------------------------
  -- Top products for the last seven days
  -- --------------------------------------------------------------------------

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'base_quantity', base_quantity,
      'sales_amount', sales_amount,
      'profit_amount',
        case
          when v_can_view_profit
            then profit_amount
          else null
        end
    )
    order by sales_amount desc
  ), '[]'::jsonb)
  into v_top_products
  from (
    select
      si.product_id,
      max(si.product_name) as product_name,

      sum(
        coalesce(si.base_quantity, si.quantity)
      ) as base_quantity,

      sum(private.convert_to_base_currency(
        si.line_total,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as sales_amount,

      sum(private.convert_to_base_currency(
        si.line_profit,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as profit_amount

    from public.sale_items si
    join public.sales s
      on s.id = si.sale_id

    where s.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or s.branch_id = v_branch_id
      )
      and s.status in (
        'completed',
        'partially_refunded',
        'refunded'
      )
      and (
        timezone(
          v_timezone,
          coalesce(s.completed_at, s.created_at)
        )
      )::date between v_trend_start and v_today

    group by si.product_id
    order by sales_amount desc
    limit 8
  ) top_rows;

  -- --------------------------------------------------------------------------
  -- Recent sales
  -- --------------------------------------------------------------------------

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'invoice_number', invoice_number,
      'completed_at', completed_at,
      'status', status,
      'currency', currency,
      'gross_total', gross_total,
      'refund_total', refund_total,
      'net_total', gross_total - refund_total,
      'customer_name', customer_name,
      'cashier_name', cashier_name,
      'branch_name', branch_name
    )
    order by completed_at desc
  ), '[]'::jsonb)
  into v_recent_sales
  from (
    select
      s.id,
      s.invoice_number,
      coalesce(s.completed_at, s.created_at) as completed_at,
      s.status,
      v_base_currency as currency,

      private.convert_to_base_currency(
        s.total_amount,
        s.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as gross_total,

      coalesce((
        select sum(private.convert_to_base_currency(
          r.refund_amount,
          r.currency,
          v_base_currency,
          v_usd_to_khr_rate
        ))
        from public.returns r
        where r.original_sale_id = s.id
          and r.status = 'completed'
      ), 0) as refund_total,

      coalesce(c.name, 'Walk-in customer') as customer_name,
      coalesce(p.full_name, 'POS Staff') as cashier_name,
      b.name as branch_name

    from public.sales s
    left join public.customers c
      on c.id = s.customer_id
    left join public.profiles p
      on p.id = s.cashier_id
    join public.branches b
      on b.id = s.branch_id

    where s.organization_id = v_profile.organization_id
      and (
        v_all_branches
        or s.branch_id = v_branch_id
      )
      and s.status in (
        'completed',
        'partially_refunded',
        'refunded'
      )

    order by coalesce(s.completed_at, s.created_at) desc
    limit 10
  ) recent_rows;

  -- --------------------------------------------------------------------------
  -- Branch performance for owner/admin all-branch view
  -- --------------------------------------------------------------------------

  if v_all_branches then
    with branch_sales as (
      select
        s.branch_id,

        sum(private.convert_to_base_currency(
          s.total_amount,
          s.currency,
          v_base_currency,
          v_usd_to_khr_rate
        )) as gross_sales,

        sum(private.convert_to_base_currency(
          s.gross_profit,
          s.currency,
          v_base_currency,
          v_usd_to_khr_rate
        )) as gross_profit,

        count(*) as sale_count

      from public.sales s

      where s.organization_id = v_profile.organization_id
        and s.status in (
          'completed',
          'partially_refunded',
          'refunded'
        )
        and (
          timezone(
            v_timezone,
            coalesce(s.completed_at, s.created_at)
          )
        )::date = v_today

      group by s.branch_id
    ),

    branch_returns as (
      select
        r.branch_id,

        sum(private.convert_to_base_currency(
          r.refund_amount,
          r.currency,
          v_base_currency,
          v_usd_to_khr_rate
        )) as refunds,

        sum(private.convert_to_base_currency(
          r.profit_reversal,
          r.currency,
          v_base_currency,
          v_usd_to_khr_rate
        )) as profit_reversal

      from public.returns r

      where r.organization_id = v_profile.organization_id
        and r.status = 'completed'
        and (
          timezone(v_timezone, r.processed_at)
        )::date = v_today

      group by r.branch_id
    )

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'branch_id', b.id,
        'branch_name', b.name,
        'branch_code', b.code,
        'sale_count', coalesce(s.sale_count, 0),
        'gross_sales', coalesce(s.gross_sales, 0),
        'refunds', coalesce(r.refunds, 0),
        'net_sales',
          coalesce(s.gross_sales, 0)
          - coalesce(r.refunds, 0),
        'net_profit',
          case
            when v_can_view_profit then
              coalesce(s.gross_profit, 0)
              - coalesce(r.profit_reversal, 0)
            else null
          end
      )
      order by (
        coalesce(s.gross_sales, 0)
        - coalesce(r.refunds, 0)
      ) desc
    ), '[]'::jsonb)
    into v_branch_performance
    from public.branches b
    left join branch_sales s
      on s.branch_id = b.id
    left join branch_returns r
      on r.branch_id = b.id
    where b.organization_id = v_profile.organization_id
      and b.is_active = true;
  end if;

  -- --------------------------------------------------------------------------
  -- Product, customer and staff counts
  -- --------------------------------------------------------------------------

  select jsonb_build_object(
    'active_products', (
      select count(*)
      from public.products p
      where p.organization_id = v_profile.organization_id
        and p.is_active = true
    ),

    'active_customers', (
      select count(*)
      from public.customers c
      where c.organization_id = v_profile.organization_id
        and c.is_active = true
    ),

    'active_staff', (
      select count(*)
      from public.profiles p
      where p.organization_id = v_profile.organization_id
        and p.is_active = true
    ),

    'active_branches', (
      select count(*)
      from public.branches b
      where b.organization_id = v_profile.organization_id
        and b.is_active = true
    )
  )
  into v_quick_counts;

  -- --------------------------------------------------------------------------
  -- Current selected branch register
  -- --------------------------------------------------------------------------

  select coalesce((
    select jsonb_build_object(
      'is_open', true,
      'id', cr.id,
      'session_number', cr.session_number,
      'register_name', cr.register_name,
      'opened_at', cr.opened_at,
      'opened_by', p.full_name,
      'opening_cash_usd', cr.opening_cash_usd,
      'opening_cash_khr', cr.opening_cash_khr,
      'open_minutes',
        greatest(
          0,
          floor(
            extract(epoch from (now() - cr.opened_at))
            / 60
          )
        )
    )
    from public.cash_register_sessions cr
    left join public.profiles p
      on p.id = cr.opened_by
    where cr.organization_id = v_profile.organization_id
      and cr.branch_id = v_profile.branch_id
      and cr.status = 'open'
    limit 1
  ), jsonb_build_object(
    'is_open', false,
    'session_number', null,
    'register_name', null,
    'opened_at', null,
    'opened_by', null,
    'opening_cash_usd', 0,
    'opening_cash_khr', 0,
    'open_minutes', 0
  ))
  into v_register;

  v_register_open :=
    coalesce((v_register ->> 'is_open')::boolean, false);

  -- --------------------------------------------------------------------------
  -- Action-center counts
  -- --------------------------------------------------------------------------

  with stock_rows as (
    select
      p.id as product_id,
      b.id as branch_id,
      coalesce(ib.quantity, 0) as quantity,

      coalesce(
        case
          when rr.is_active then rr.reorder_point
          else null
        end,
        p.low_stock_threshold,
        settings.low_stock_threshold,
        0
      ) as threshold

    from public.products p
    join public.app_settings settings
      on settings.organization_id = p.organization_id
    join public.branches b
      on b.organization_id = p.organization_id
      and b.is_active = true
      and (
        v_all_branches
        or b.id = v_branch_id
      )
    left join public.inventory_balances ib
      on ib.product_id = p.id
      and ib.branch_id = b.id
    left join public.reorder_rules rr
      on rr.organization_id = p.organization_id
      and rr.branch_id = b.id
      and rr.product_id = p.id

    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
  )

  select
    count(*) filter (where quantity <= 0),
    count(*) filter (
      where quantity > 0
        and quantity <= threshold
    )
  into
    v_out_of_stock,
    v_low_stock
  from stock_rows;

  select count(*)
  into v_pending_transfers
  from public.stock_transfers t
  where t.organization_id = v_profile.organization_id
    and t.status = 'pending'
    and (
      v_all_branches
      or t.source_branch_id = v_branch_id
      or t.destination_branch_id = v_branch_id
    );

  select count(*)
  into v_overdue_orders
  from public.purchases p
  where p.organization_id = v_profile.organization_id
    and (
      v_all_branches
      or p.branch_id = v_branch_id
    )
    and p.status = 'ordered'
    and p.expected_date is not null
    and p.expected_date < v_today;

  select count(*)
  into v_draft_orders
  from public.purchases p
  where p.organization_id = v_profile.organization_id
    and (
      v_all_branches
      or p.branch_id = v_branch_id
    )
    and p.status = 'draft';

  select
    count(*),
    coalesce(sum(private.convert_to_base_currency(
      greatest(p.total_amount - p.amount_paid, 0),
      p.currency,
      v_base_currency,
      v_usd_to_khr_rate
    )), 0)
  into
    v_unpaid_orders,
    v_unpaid_balance
  from public.purchases p
  where p.organization_id = v_profile.organization_id
    and (
      v_all_branches
      or p.branch_id = v_branch_id
    )
    and p.status = 'received'
    and p.amount_paid < p.total_amount;

  select count(*)
  into v_parked_sales
  from public.parked_sales ps
  where ps.organization_id = v_profile.organization_id
    and (
      v_all_branches
      or ps.branch_id = v_branch_id
    );

  select count(*)
  into v_expiring_coupons
  from public.coupons c
  where c.organization_id = v_profile.organization_id
    and c.is_active = true
    and (
      c.branch_id is null
      or v_all_branches
      or c.branch_id = v_branch_id
    )
    and c.ends_at is not null
    and c.ends_at > now()
    and c.ends_at <= now() + interval '7 days';

  select coalesce(jsonb_agg(
    alert_item
    order by priority
  ), '[]'::jsonb)
  into v_alerts
  from (
    select
      1 as priority,
      jsonb_build_object(
        'key', 'out_of_stock',
        'severity', 'danger',
        'title', 'Products out of stock',
        'detail',
          v_out_of_stock
          || ' product/branch stock record'
          || case when v_out_of_stock = 1 then '' else 's' end
          || ' need attention.',
        'count', v_out_of_stock,
        'link', '/reorder'
      ) as alert_item
    where v_out_of_stock > 0

    union all

    select
      2,
      jsonb_build_object(
        'key', 'low_stock',
        'severity', 'warning',
        'title', 'Low-stock products',
        'detail',
          v_low_stock
          || ' product/branch stock record'
          || case when v_low_stock = 1 then '' else 's' end
          || ' reached the reorder point.',
        'count', v_low_stock,
        'link', '/reorder'
      )
    where v_low_stock > 0

    union all

    select
      3,
      jsonb_build_object(
        'key', 'overdue_orders',
        'severity', 'danger',
        'title', 'Overdue purchase orders',
        'detail',
          v_overdue_orders
          || ' ordered purchase order'
          || case when v_overdue_orders = 1 then ' is' else 's are' end
          || ' past the expected date.',
        'count', v_overdue_orders,
        'link', '/purchase-orders'
      )
    where v_overdue_orders > 0
      and v_profile.role in ('owner','admin','manager')

    union all

    select
      4,
      jsonb_build_object(
        'key', 'pending_transfers',
        'severity', 'info',
        'title', 'Pending stock transfers',
        'detail',
          v_pending_transfers
          || ' transfer'
          || case when v_pending_transfers = 1 then ' is' else 's are' end
          || ' waiting to be received or cancelled.',
        'count', v_pending_transfers,
        'link', '/transfers'
      )
    where v_pending_transfers > 0
      and v_profile.role in ('owner','admin','manager')

    union all

    select
      5,
      jsonb_build_object(
        'key', 'unpaid_suppliers',
        'severity', 'warning',
        'title', 'Supplier balances due',
        'detail',
          v_unpaid_orders
          || ' received purchase order'
          || case when v_unpaid_orders = 1 then ' has' else 's have' end
          || ' an unpaid balance.',
        'count', v_unpaid_orders,
        'amount', v_unpaid_balance,
        'currency', v_base_currency,
        'link', '/purchase-orders'
      )
    where v_unpaid_orders > 0
      and v_profile.role in ('owner','admin','manager')

    union all

    select
      6,
      jsonb_build_object(
        'key', 'draft_orders',
        'severity', 'neutral',
        'title', 'Draft purchase orders',
        'detail',
          v_draft_orders
          || ' draft purchase order'
          || case when v_draft_orders = 1 then ' needs' else 's need' end
          || ' review.',
        'count', v_draft_orders,
        'link', '/purchase-orders'
      )
    where v_draft_orders > 0
      and v_profile.role in ('owner','admin','manager')

    union all

    select
      7,
      jsonb_build_object(
        'key', 'parked_sales',
        'severity', 'info',
        'title', 'Parked sales',
        'detail',
          v_parked_sales
          || ' parked bill'
          || case when v_parked_sales = 1 then ' is' else 's are' end
          || ' waiting to be resumed.',
        'count', v_parked_sales,
        'link', '/sales'
      )
    where v_parked_sales > 0
      and v_profile.role in ('owner','admin','manager','cashier')

    union all

    select
      8,
      jsonb_build_object(
        'key', 'expiring_coupons',
        'severity', 'neutral',
        'title', 'Coupons expiring soon',
        'detail',
          v_expiring_coupons
          || ' active coupon'
          || case when v_expiring_coupons = 1 then ' expires' else 's expire' end
          || ' within seven days.',
        'count', v_expiring_coupons,
        'link', '/coupons'
      )
    where v_expiring_coupons > 0
      and v_profile.role in ('owner','admin','manager')

    union all

    select
      9,
      jsonb_build_object(
        'key', 'register_closed',
        'severity', 'warning',
        'title', 'Cash register is closed',
        'detail',
          'Open the selected branch register before accepting cash.',
        'count', 1,
        'link', '/cash-register'
      )
    where v_register_open is false
      and v_profile.role in ('owner','admin','manager','cashier')
  ) alerts;

  return jsonb_build_object(
    'meta', jsonb_build_object(
      'generated_at', now(),
      'business_date', v_today,
      'timezone', v_timezone,
      'base_currency', v_base_currency,
      'scope',
        case
          when v_all_branches then 'all_branches'
          else 'branch'
        end,
      'branch_id', v_branch_id,
      'branch_name', v_branch_name,
      'selected_branch_id', v_profile.branch_id,
      'role', v_profile.role,
      'can_view_profit', v_can_view_profit,
      'can_all_branches', v_can_view_all_branches
    ),

    'today', v_today_summary,
    'periods', v_period_summary,
    'trend', v_trend,
    'payment_methods', v_payment_methods,
    'top_products', v_top_products,
    'recent_sales', v_recent_sales,
    'branch_performance', v_branch_performance,
    'quick_counts', v_quick_counts,
    'register', v_register,
    'alerts', v_alerts
  );
end;
$$;

revoke all on function public.get_dashboard_action_center(boolean)
  from public, anon;

grant execute on function public.get_dashboard_action_center(boolean)
  to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 21
-- ============================================================================
