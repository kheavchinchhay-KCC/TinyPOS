-- ============================================================================
-- Tiny POS - Step 28: Invoice Center and Sales History
-- Run once in the NEW Supabase project after Step 27.
--
-- Adds one secure, paginated reporting RPC. It does not create, delete, or
-- modify invoices, payments, returns, stock, customers, or credit accounts.
-- ============================================================================

begin;

create or replace function public.get_invoice_center(
  p_from date,
  p_to date,
  p_search text default null,
  p_sale_status text default null,
  p_payment_status text default null,
  p_payment_method text default null,
  p_currency public.currency_code default null,
  p_branch_id uuid default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;

  v_timezone text := 'Asia/Phnom_Penh';
  v_can_view_profit boolean := false;
  v_can_view_all_branches boolean := false;
  v_all_branches boolean := false;
  v_effective_branch_id uuid;

  v_from date := coalesce(p_from, current_date - 30);
  v_to date := coalesce(p_to, current_date);
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 10), 1000);
  v_offset integer;

  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    profile_row.organization_id,
    profile_row.branch_id,
    profile_row.role,
    profile_row.is_active
  into v_profile
  from public.profiles profile_row
  where profile_row.id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in (
    'owner',
    'admin',
    'manager',
    'cashier',
    'viewer'
  ) then
    raise exception 'Your role cannot view invoice history';
  end if;

  if v_from > v_to then
    raise exception 'The From date cannot be after the To date';
  end if;

  if v_to - v_from > 1095 then
    raise exception 'Invoice Center date range cannot exceed three years';
  end if;

  v_can_view_profit :=
    v_profile.role in ('owner', 'admin', 'manager', 'viewer');

  v_can_view_all_branches :=
    v_profile.role in ('owner', 'admin');

  if v_can_view_all_branches and p_branch_id is null then
    v_all_branches := true;
    v_effective_branch_id := null;
  elsif v_can_view_all_branches and p_branch_id is not null then
    if not exists (
      select 1
      from public.branches branch_row
      where branch_row.id = p_branch_id
        and branch_row.organization_id = v_profile.organization_id
        and branch_row.is_active = true
    ) then
      raise exception 'Selected branch not found or inactive';
    end if;

    v_effective_branch_id := p_branch_id;
  else
    v_effective_branch_id := v_profile.branch_id;
  end if;

  select coalesce(
    nullif(trim(settings.timezone), ''),
    'Asia/Phnom_Penh'
  )
  into v_timezone
  from public.app_settings settings
  where settings.organization_id = v_profile.organization_id;

  v_timezone := coalesce(v_timezone, 'Asia/Phnom_Penh');
  v_offset := (v_page - 1) * v_page_size;

  with sale_rollup as (
    select
      sale_row.*,
      branch_row.name as branch_name,
      branch_row.code as branch_code,
      customer_row.customer_code,
      customer_row.customer_type,
      customer_row.name as customer_name,
      customer_row.company_name as customer_company,
      customer_row.phone as customer_phone,
      customer_row.email as customer_email,
      customer_row.address as customer_address,
      cashier_row.full_name as cashier_name,
      quote_row.quote_number as source_quote_number,

      coalesce((
        select sum(return_row.refund_amount)
        from public.returns return_row
        where return_row.original_sale_id = sale_row.id
          and return_row.status = 'completed'
      ), 0)::numeric(14,2) as refunded_amount,

      coalesce((
        select sum(return_row.profit_reversal)
        from public.returns return_row
        where return_row.original_sale_id = sale_row.id
          and return_row.status = 'completed'
      ), 0)::numeric(14,4) as profit_reversal,

      (
        select count(*)
        from public.returns return_row
        where return_row.original_sale_id = sale_row.id
          and return_row.status = 'completed'
      )::integer as return_count,

      case
        when sale_row.credit_account_id is not null then 'credit'
        else coalesce((
          select string_agg(
            distinct payment_row.method::text,
            ', '
            order by payment_row.method::text
          )
          from public.payments payment_row
          where payment_row.sale_id = sale_row.id
            and payment_row.credit_payment_id is null
        ), 'other')
      end as payment_method_label,

      greatest(
        coalesce(sale_row.credit_amount, 0)
          - coalesce(sale_row.paid_amount, 0),
        0
      )::numeric(14,2) as credit_outstanding

    from public.sales sale_row
    join public.branches branch_row
      on branch_row.id = sale_row.branch_id
    left join public.customers customer_row
      on customer_row.id = sale_row.customer_id
    left join public.profiles cashier_row
      on cashier_row.id = sale_row.cashier_id
    left join public.sales_quotes quote_row
      on quote_row.id = sale_row.source_quote_id

    where sale_row.organization_id = v_profile.organization_id
      and sale_row.status in (
        'completed',
        'partially_refunded',
        'refunded',
        'voided'
      )
      and (
        v_all_branches
        or sale_row.branch_id = v_effective_branch_id
      )
      and (
        timezone(
          v_timezone,
          coalesce(sale_row.completed_at, sale_row.created_at)
        )
      )::date between v_from and v_to
  ),

  filtered as (
    select sale_rollup.*
    from sale_rollup
    where
      (
        nullif(trim(p_sale_status), '') is null
        or sale_rollup.status::text = lower(trim(p_sale_status))
      )
      and (
        nullif(trim(p_payment_status), '') is null
        or sale_rollup.payment_status::text = lower(trim(p_payment_status))
      )
      and (
        p_currency is null
        or sale_rollup.currency = p_currency
      )
      and (
        nullif(trim(p_payment_method), '') is null
        or (
          lower(trim(p_payment_method)) = 'credit'
          and sale_rollup.credit_account_id is not null
        )
        or (
          lower(trim(p_payment_method)) <> 'credit'
          and sale_rollup.credit_account_id is null
          and exists (
            select 1
            from public.payments payment_filter
            where payment_filter.sale_id = sale_rollup.id
              and payment_filter.credit_payment_id is null
              and payment_filter.method::text = lower(trim(p_payment_method))
          )
        )
      )
      and (
        nullif(trim(p_search), '') is null
        or lower(sale_rollup.invoice_number)
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.customer_name, ''))
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.customer_company, ''))
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.customer_code, ''))
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.customer_phone, ''))
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.cashier_name, ''))
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.source_quote_number, ''))
          like '%' || lower(trim(p_search)) || '%'
        or lower(coalesce(sale_rollup.price_list_name, ''))
          like '%' || lower(trim(p_search)) || '%'
        or exists (
          select 1
          from public.sale_items item_search
          where item_search.sale_id = sale_rollup.id
            and (
              lower(item_search.product_name)
                like '%' || lower(trim(p_search)) || '%'
              or lower(coalesce(item_search.barcode, ''))
                like '%' || lower(trim(p_search)) || '%'
            )
        )
        or exists (
          select 1
          from public.payments payment_search
          where payment_search.sale_id = sale_rollup.id
            and lower(coalesce(payment_search.reference_number, ''))
              like '%' || lower(trim(p_search)) || '%'
        )
        or exists (
          select 1
          from public.returns return_search
          where return_search.original_sale_id = sale_rollup.id
            and (
              lower(return_search.return_number)
                like '%' || lower(trim(p_search)) || '%'
              or lower(coalesce(return_search.refund_reference, ''))
                like '%' || lower(trim(p_search)) || '%'
            )
        )
      )
  ),

  paged as (
    select filtered.*
    from filtered
    order by
      coalesce(filtered.completed_at, filtered.created_at) desc,
      filtered.invoice_number desc
    limit v_page_size
    offset v_offset
  ),

  row_json as (
    select
      coalesce(invoice.completed_at, invoice.created_at) as sort_at,
      invoice.invoice_number as sort_invoice,
      jsonb_build_object(
      'id', invoice.id,
      'invoice_number', invoice.invoice_number,
      'branch_id', invoice.branch_id,
      'branch_name', invoice.branch_name,
      'branch_code', invoice.branch_code,
      'customer_id', invoice.customer_id,
      'customer', case
        when invoice.customer_id is null then null
        else jsonb_build_object(
          'id', invoice.customer_id,
          'customer_code', invoice.customer_code,
          'customer_type', invoice.customer_type,
          'name', invoice.customer_name,
          'company_name', invoice.customer_company,
          'phone', invoice.customer_phone,
          'email', invoice.customer_email,
          'address', invoice.customer_address
        )
      end,
      'cashier_id', invoice.cashier_id,
      'cashier_name', coalesce(invoice.cashier_name, 'POS Staff'),
      'status', invoice.status,
      'payment_status', invoice.payment_status,
      'payment_method', invoice.payment_method_label,
      'currency', invoice.currency,
      'subtotal', invoice.subtotal,
      'price_list_id', invoice.price_list_id,
      'price_list_name', invoice.price_list_name,
      'price_adjustment_amount', invoice.price_adjustment_amount,
      'discount_type', invoice.discount_type,
      'discount_value', invoice.discount_value,
      'discount_amount', invoice.discount_amount,
      'coupon_code', invoice.coupon_code,
      'coupon_discount_amount', invoice.coupon_discount_amount,
      'tax_amount', invoice.tax_amount,
      'total_amount', invoice.total_amount,
      'paid_amount', invoice.paid_amount,
      'change_amount', invoice.change_amount,
      'refunded_amount', invoice.refunded_amount,
      'net_total', case
        when invoice.status = 'voided' then 0
        else greatest(invoice.total_amount - invoice.refunded_amount, 0)
      end,
      'return_count', invoice.return_count,
      'cost_amount', case
        when v_can_view_profit then invoice.cost_amount
        else null
      end,
      'gross_profit', case
        when v_can_view_profit then invoice.gross_profit
        else null
      end,
      'profit_reversal', case
        when v_can_view_profit then invoice.profit_reversal
        else null
      end,
      'net_profit', case
        when v_can_view_profit then invoice.gross_profit - invoice.profit_reversal
        else null
      end,
      'credit_account_id', invoice.credit_account_id,
      'credit_due_date', invoice.credit_due_date,
      'credit_amount', invoice.credit_amount,
      'credit_outstanding', invoice.credit_outstanding,
      'source_quote_id', invoice.source_quote_id,
      'source_quote_number', invoice.source_quote_number,
      'notes', invoice.notes,
      'completed_at', invoice.completed_at,
      'created_at', invoice.created_at,
      'voided_at', invoice.voided_at,
      'void_reason', invoice.void_reason,

      'items', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', item.id,
            'product_id', item.product_id,
            'product_unit_id', item.product_unit_id,
            'product_name', item.product_name,
            'barcode', item.barcode,
            'quantity', item.quantity,
            'base_quantity', item.base_quantity,
            'sale_unit_name', item.sale_unit_name,
            'unit_factor', item.unit_factor,
            'list_price', item.list_price,
            'unit_price', item.unit_price,
            'unit_cost', case
              when v_can_view_profit then item.unit_cost
              else null
            end,
            'price_list_id', item.price_list_id,
            'price_adjustment_amount', item.price_adjustment_amount,
            'discount_amount', item.discount_amount,
            'tax_amount', item.tax_amount,
            'line_total', item.line_total,
            'line_profit', case
              when v_can_view_profit then item.line_profit
              else null
            end
          )
          order by item.created_at, item.product_name
        )
        from public.sale_items item
        where item.sale_id = invoice.id
      ), '[]'::jsonb),

      'payments', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', payment.id,
            'method', payment.method,
            'currency', payment.currency,
            'amount', payment.amount,
            'tendered_amount', payment.tendered_amount,
            'change_amount', payment.change_amount,
            'reference_number', payment.reference_number,
            'paid_at', payment.paid_at,
            'notes', payment.notes,
            'is_credit_collection', payment.credit_payment_id is not null
          )
          order by payment.paid_at, payment.id
        )
        from public.payments payment
        where payment.sale_id = invoice.id
      ), '[]'::jsonb),

      'returns', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', return_row.id,
            'return_number', return_row.return_number,
            'status', return_row.status,
            'currency', return_row.currency,
            'refund_amount', return_row.refund_amount,
            'refund_method', case
              when return_row.credit_refund_amount > 0 then 'credit'
              else return_row.refund_method::text
            end,
            'refund_reference', return_row.refund_reference,
            'credit_refund_amount', return_row.credit_refund_amount,
            'reason', return_row.reason,
            'processed_at', return_row.processed_at,
            'tax_refund', return_row.tax_refund,
            'cost_amount', case
              when v_can_view_profit then return_row.cost_amount
              else null
            end,
            'profit_reversal', case
              when v_can_view_profit then return_row.profit_reversal
              else null
            end,
            'items', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id', returned_item.id,
                  'sale_item_id', returned_item.sale_item_id,
                  'product_id', returned_item.product_id,
                  'quantity', returned_item.quantity,
                  'base_quantity', returned_item.base_quantity,
                  'return_unit_name', returned_item.return_unit_name,
                  'unit_factor', returned_item.unit_factor,
                  'unit_refund', returned_item.unit_refund,
                  'line_refund', returned_item.line_refund,
                  'restock', returned_item.restock,
                  'tax_refund', returned_item.tax_refund,
                  'product_name', sold_item.product_name
                )
                order by returned_item.created_at
              )
              from public.return_items returned_item
              left join public.sale_items sold_item
                on sold_item.id = returned_item.sale_item_id
              where returned_item.return_id = return_row.id
            ), '[]'::jsonb)
          )
          order by return_row.processed_at, return_row.return_number
        )
        from public.returns return_row
        where return_row.original_sale_id = invoice.id
          and return_row.status = 'completed'
      ), '[]'::jsonb)
    ) as row_data
    from paged invoice
  ),

  summary_usd as (
    select jsonb_build_object(
      'invoice_count', count(*),
      'gross_sales', coalesce(sum(
        case when status = 'voided' then 0 else total_amount end
      ), 0),
      'refunds', coalesce(sum(
        case when status = 'voided' then 0 else refunded_amount end
      ), 0),
      'net_sales', coalesce(sum(
        case
          when status = 'voided' then 0
          else greatest(total_amount - refunded_amount, 0)
        end
      ), 0),
      'paid_amount', coalesce(sum(
        case when status = 'voided' then 0 else paid_amount end
      ), 0),
      'credit_outstanding', coalesce(sum(
        case when status = 'voided' then 0 else credit_outstanding end
      ), 0),
      'gross_profit', case
        when v_can_view_profit then coalesce(sum(
          case when status = 'voided' then 0 else gross_profit end
        ), 0)
        else null
      end,
      'net_profit', case
        when v_can_view_profit then coalesce(sum(
          case
            when status = 'voided' then 0
            else gross_profit - profit_reversal
          end
        ), 0)
        else null
      end
    ) as summary
    from filtered
    where currency = 'USD'
  ),

  summary_khr as (
    select jsonb_build_object(
      'invoice_count', count(*),
      'gross_sales', coalesce(sum(
        case when status = 'voided' then 0 else total_amount end
      ), 0),
      'refunds', coalesce(sum(
        case when status = 'voided' then 0 else refunded_amount end
      ), 0),
      'net_sales', coalesce(sum(
        case
          when status = 'voided' then 0
          else greatest(total_amount - refunded_amount, 0)
        end
      ), 0),
      'paid_amount', coalesce(sum(
        case when status = 'voided' then 0 else paid_amount end
      ), 0),
      'credit_outstanding', coalesce(sum(
        case when status = 'voided' then 0 else credit_outstanding end
      ), 0),
      'gross_profit', case
        when v_can_view_profit then coalesce(sum(
          case when status = 'voided' then 0 else gross_profit end
        ), 0)
        else null
      end,
      'net_profit', case
        when v_can_view_profit then coalesce(sum(
          case
            when status = 'voided' then 0
            else gross_profit - profit_reversal
          end
        ), 0)
        else null
      end
    ) as summary
    from filtered
    where currency = 'KHR'
  )

  select jsonb_build_object(
    'meta', jsonb_build_object(
      'generated_at', now(),
      'timezone', v_timezone,
      'from', v_from,
      'to', v_to,
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', (select count(*) from filtered),
      'total_pages', greatest(
        ceil((select count(*) from filtered)::numeric / v_page_size)::integer,
        1
      ),
      'can_view_profit', v_can_view_profit,
      'can_view_all_branches', v_can_view_all_branches,
      'selected_branch_id', v_effective_branch_id,
      'all_branches', v_all_branches,
      'branches', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', branch_row.id,
            'name', branch_row.name,
            'code', branch_row.code
          )
          order by branch_row.name
        )
        from public.branches branch_row
        where branch_row.organization_id = v_profile.organization_id
          and branch_row.is_active = true
          and (
            v_can_view_all_branches
            or branch_row.id = v_profile.branch_id
          )
      ), '[]'::jsonb)
    ),
    'summary', jsonb_build_object(
      'USD', (select summary from summary_usd),
      'KHR', (select summary from summary_khr)
    ),
    'rows', coalesce((
      select jsonb_agg(
        row_data
        order by sort_at desc, sort_invoice desc
      )
      from row_json
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_invoice_center(
  date,
  date,
  text,
  text,
  text,
  text,
  public.currency_code,
  uuid,
  integer,
  integer
) from public, anon;

grant execute on function public.get_invoice_center(
  date,
  date,
  text,
  text,
  text,
  text,
  public.currency_code,
  uuid,
  integer,
  integer
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 28
-- ============================================================================
