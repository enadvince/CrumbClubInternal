-- Per-event report used by the end-of-day close screen and the printable summary.
-- Revenue figures are net of discounts: Σ(allocated_revenue − allocated_discount) = Σ transaction totals.

create or replace function public.event_report(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_event public.events;
begin
  select * into v_event from public.events where id = p_event_id;
  if v_event.id is null then perform public._fail('event not found'); end if;
  perform public._require_owner(v_event.business_id);

  return jsonb_build_object(
    'event', to_jsonb(v_event),
    'totals', (
      select jsonb_build_object(
        'transactions', count(*) filter (where status = 'completed'),
        'voided', count(*) filter (where status = 'voided'),
        'voided_total_centavos', coalesce(sum(total_centavos) filter (where status = 'voided'), 0),
        'revenue_centavos', coalesce(sum(total_centavos) filter (where status = 'completed'), 0),
        'subtotal_centavos', coalesce(sum(subtotal_centavos) filter (where status = 'completed'), 0),
        'discount_centavos', coalesce(sum(discount_centavos) filter (where status = 'completed'), 0),
        'items', coalesce(sum(item_count) filter (where status = 'completed'), 0),
        'cash_centavos', coalesce(sum(total_centavos) filter (where status = 'completed' and payment_method = 'cash'), 0),
        'qr_centavos', coalesce(sum(total_centavos) filter (where status = 'completed' and payment_method = 'qr_ph'), 0),
        'qr_count', count(*) filter (where status = 'completed' and payment_method = 'qr_ph'),
        'cost_centavos', coalesce((
          select sum(c.quantity * c.unit_cost_centavos)
          from public.transaction_line_components c join public.transactions t2 on t2.id = c.transaction_id
          where t2.event_id = p_event_id and t2.status = 'completed'), 0),
        'flagged', count(*) filter (where cardinality(flags) > 0),
        'last_synced_at', max(synced_at)
      )
      from public.transactions where event_id = p_event_id
    ),
    'cash', (
      select jsonb_build_object(
        'opening_float_centavos', coalesce(cs.opening_float_centavos, 0),
        'cash_sales_centavos', coalesce((select sum(cash_received_centavos - change_given_centavos) from public.transactions
                                  where event_id = p_event_id and status = 'completed' and payment_method = 'cash'), 0),
        'expected_cash_centavos', coalesce(cs.opening_float_centavos, 0)
            + coalesce((select sum(cash_received_centavos - change_given_centavos) from public.transactions
                        where event_id = p_event_id and status = 'completed' and payment_method = 'cash'), 0),
        'counted_cash_centavos', cs.counted_cash_centavos,
        'variance_centavos', cs.variance_centavos,
        'notes', cs.notes,
        'closed_at', cs.closed_at
      )
      from (select 1) one left join public.cash_sessions cs on cs.event_id = p_event_id
    ),
    'products', coalesce((
      select jsonb_agg(row_to_json(x) order by x.sort_order, x.name)
      from (
        select ep.id as event_product_id, p.id as product_id, p.name, ep.sort_order,
               ep.price_centavos, p.cost_centavos, ep.starting_stock, ep.current_stock, ep.sold_out_at,
               ep.closing_stock, ep.closing_unit_cost,
               coalesce(adj.restocked, 0) as restocked,
               coalesce(adj.waste, 0) as waste,
               coalesce(adj.staff_meal, 0) as staff_meal,
               coalesce(adj.giveaway, 0) as giveaway,
               coalesce(adj.correction, 0) as correction,
               coalesce(adj.waste_cost, 0) as waste_cost_centavos,
               coalesce(s.sold, 0) as sold,
               coalesce(s.revenue, 0) as revenue_centavos,
               coalesce(s.cost, 0) as cost_centavos_sold,
               coalesce(s.sold_in_bundles, 0) as sold_in_bundles
        from public.event_products ep
        join public.products p on p.id = ep.product_id
        left join lateral (
          select sum(quantity_change) filter (where reason = 'restock') as restocked,
                 -sum(quantity_change) filter (where reason = 'waste') as waste,
                 -sum(quantity_change) filter (where reason = 'staff_meal') as staff_meal,
                 -sum(quantity_change) filter (where reason = 'giveaway') as giveaway,
                 sum(quantity_change) filter (where reason = 'correction') as correction,
                 sum(-quantity_change * unit_cost_centavos) filter (where reason = 'waste') as waste_cost
          from public.stock_adjustments a where a.event_product_id = ep.id
        ) adj on true
        left join lateral (
          select sum(c.quantity) as sold,
                 sum(c.allocated_revenue_centavos - c.allocated_discount_centavos) as revenue,
                 sum(c.quantity * c.unit_cost_centavos) as cost,
                 sum(c.quantity) filter (where l.kind = 'bundle') as sold_in_bundles
          from public.transaction_line_components c
          join public.transactions t on t.id = c.transaction_id and t.status = 'completed'
          join public.transaction_lines l on l.id = c.line_id
          where c.event_product_id = ep.id
        ) s on true
        where ep.event_id = p_event_id
      ) x
    ), '[]'::jsonb),
    'bundles', coalesce((
      select jsonb_agg(row_to_json(b) order by b.revenue_centavos desc)
      from (
        select l.bundle_id, max(l.name_snapshot) as name, sum(l.quantity) as units,
               sum(l.line_total_centavos) as revenue_centavos
        from public.transaction_lines l join public.transactions t on t.id = l.transaction_id
        where t.event_id = p_event_id and t.status = 'completed' and l.kind = 'bundle'
        group by l.bundle_id
      ) b
    ), '[]'::jsonb),
    'qr_payments', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'time', client_created_at, 'reference', qr_reference,
                                          'amount_centavos', total_centavos, 'flags', flags) order by client_created_at)
      from public.transactions where event_id = p_event_id and status = 'completed' and payment_method = 'qr_ph'
    ), '[]'::jsonb),
    'device', (
      select jsonb_build_object('last_seen_at', max(last_seen_at), 'unsynced_count', sum(unsynced_count),
                                'oldest_unsynced_at', min(oldest_unsynced_at))
      from public.device_heartbeats where business_id = v_event.business_id
    )
  );
end $$;

revoke all on function public.event_report(uuid) from public, anon;
grant execute on function public.event_report(uuid) to authenticated;
