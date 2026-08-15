-- Tiny POS Step 46.1: Bulk stock-count entry
-- Run once after database/41_step46_stability_ui_recovery.sql.
-- Saves every edited product count in one atomic database transaction.

begin;

create or replace function public.save_stock_count_items_bulk_v2(
  p_session_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_item jsonb;
  v_product_id uuid;
  v_counted_quantity numeric;
  v_note text;
  v_saved integer := 0;
begin
  perform private.require_permission('stock_counts.manage');

  if p_session_id is null then
    raise exception 'Stock count session is required';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one stock count item is required';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_counted_quantity := case
      when not (v_item ? 'counted_quantity')
        or v_item->'counted_quantity' = 'null'::jsonb then null
      else (v_item->>'counted_quantity')::numeric
    end;
    v_note := nullif(btrim(coalesce(v_item->>'note', '')), '');

    if v_product_id is null then
      raise exception 'Every stock count row requires a product';
    end if;

    if v_counted_quantity is not null and v_counted_quantity < 0 then
      raise exception 'Counted quantity cannot be negative';
    end if;

    perform public.save_stock_count_item(
      p_session_id,
      v_product_id,
      v_counted_quantity,
      v_note
    );

    v_saved := v_saved + 1;
  end loop;

  return jsonb_build_object(
    'session_id', p_session_id,
    'saved_items', v_saved
  );
end;
$$;

grant execute on function public.save_stock_count_items_bulk_v2(uuid, jsonb)
  to authenticated;

commit;
