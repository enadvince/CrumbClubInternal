-- Owner dashboard aggregates. All time bucketing is in Asia/Manila.
-- Scope: either one event (p_event_id) or a time range [p_from, p_to) on the sale time.
-- Revenue is net of discounts everywhere (Σ allocated_revenue − allocated_discount = Σ totals).

create or replace function public._dash_txns(p_business uuid, p_from timestamptz, p_to timestamptz, p_event_id uuid)
returns setof public.transactions language sql stable security definer set search_path = public as $$
  select * from public.transactions t
  where t.business_id = p_business
    and t.status = 'completed'
    and (p_event_id is null or t.event_id = p_event_id)
    and (p_from is null or t.client_created_at >= p_from)
    and (p_to is null or t.client_created_at < p_to);
$$;

create or replace function public.dashboard_report(
  p_from timestamptz default null, p_to timestamptz default null, p_event_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_business uuid;
  v_tz constant text := 'Asia/Manila';
  v_from_date date := (p_from at time zone 'Asia/Manila')::date;
  v_to_date date := ((p_to - interval '1 microsecond') at time zone 'Asia/Manila')::date;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  if v_business is null then raise exception 'owner access required' using errcode = '42501'; end if;
  if p_event_id is not null and not exists (select 1 from public.events where id = p_event_id and business_id = v_business) then
    perform public._fail('event not found');
  end if;

  return jsonb_build_object(
    'kpis', (
      with t as (select * from public._dash_txns(v_business, p_from, p_to, p_event_id)),
      c as (
        select c.*, l.kind from public.transaction_line_components c
        join t on t.id = c.transaction_id join public.transaction_lines l on l.id = c.line_id
      )
      select jsonb_build_object(
        'revenue_centavos', coalesce((select sum(total_centavos) from t), 0),
        'cost_centavos', coalesce((select sum(quantity * unit_cost_centavos) from c), 0),
        'transactions', (select count(*) from t),
        'items', coalesce((select sum(item_count) from t), 0),
        'cash_centavos', coalesce((select sum(total_centavos) from t where payment_method = 'cash'), 0),
        'qr_centavos', coalesce((select sum(total_centavos) from t where payment_method = 'qr_ph'), 0),
        'bundle_revenue_centavos', coalesce((select sum(allocated_revenue_centavos - allocated_discount_centavos) from c where kind = 'bundle'), 0),
        'transactions_with_bundle', (select count(*) from t where has_bundle),
        'discount_centavos', coalesce((select sum(discount_centavos) from t), 0),
        'first_sale_at', (select min(client_created_at) from t),
        'last_sale_at', (select max(client_created_at) from t)
      )
    ),
    'by_product', coalesce((
      select jsonb_agg(row_to_json(x) order by x.revenue_centavos desc)
      from (
        select p.id as product_id, p.name,
               sum(c.quantity) as units,
               sum(c.quantity) filter (where l.kind = 'product') as single_units,
               sum(c.quantity) filter (where l.kind = 'bundle') as bundle_units,
               sum(c.allocated_revenue_centavos - c.allocated_discount_centavos) as revenue_centavos,
               sum(c.quantity * c.unit_cost_centavos) as cost_centavos
        from public._dash_txns(v_business, p_from, p_to, p_event_id) t
        join public.transaction_line_components c on c.transaction_id = t.id
        join public.transaction_lines l on l.id = c.line_id
        join public.products p on p.id = c.product_id
        group by p.id, p.name
      ) x
    ), '[]'::jsonb),
    'bundles', coalesce((
      select jsonb_agg(row_to_json(x) order by x.revenue_centavos desc)
      from (
        select b.id as bundle_id, b.name, b.type,
               sum(l.quantity) as units,
               sum(cs.pieces) as pieces,
               sum(l.line_total_centavos) as line_total_centavos,
               sum(cs.net) as revenue_centavos,
               sum(cs.cost) as cost_centavos,
               sum(cs.separate) as separate_value_centavos
        from public._dash_txns(v_business, p_from, p_to, p_event_id) t
        join public.transaction_lines l on l.transaction_id = t.id and l.kind = 'bundle'
        join public.bundles b on b.id = l.bundle_id
        join lateral (
          select sum(c.quantity) as pieces,
                 sum(c.allocated_revenue_centavos - c.allocated_discount_centavos) as net,
                 sum(c.quantity * c.unit_cost_centavos) as cost,
                 sum(c.quantity * c.regular_unit_price_centavos) as separate
          from public.transaction_line_components c where c.line_id = l.id
        ) cs on true
        group by b.id, b.name, b.type
      ) x
    ), '[]'::jsonb),
    'mix_picks', coalesce((
      select jsonb_agg(row_to_json(x) order by x.units desc)
      from (
        select p.name, sum(c.quantity) as units
        from public._dash_txns(v_business, p_from, p_to, p_event_id) t
        join public.transaction_lines l on l.transaction_id = t.id and l.kind = 'bundle'
        join public.bundles b on b.id = l.bundle_id and b.type = 'mix_match'
        join public.transaction_line_components c on c.line_id = l.id
        join public.products p on p.id = c.product_id
        group by p.name
      ) x
    ), '[]'::jsonb),
    'by_hour', coalesce((
      select jsonb_agg(row_to_json(x) order by x.hour)
      from (
        select extract(hour from client_created_at at time zone v_tz)::int as hour,
               count(*) as transactions, sum(total_centavos) as revenue_centavos, sum(item_count) as items
        from public._dash_txns(v_business, p_from, p_to, p_event_id)
        group by 1
      ) x
    ), '[]'::jsonb),
    'by_day_hour', coalesce((
      select jsonb_agg(row_to_json(x) order by x.day, x.hour)
      from (
        select (client_created_at at time zone v_tz)::date as day,
               extract(hour from client_created_at at time zone v_tz)::int as hour,
               count(*) as transactions, sum(total_centavos) as revenue_centavos
        from public._dash_txns(v_business, p_from, p_to, p_event_id)
        group by 1, 2
      ) x
    ), '[]'::jsonb),
    'items_distribution', coalesce((
      select jsonb_agg(row_to_json(x) order by x.items)
      from (
        select least(item_count, 10) as items, count(*) as transactions
        from public._dash_txns(v_business, p_from, p_to, p_event_id)
        group by 1
      ) x
    ), '[]'::jsonb),
    'by_staff', coalesce((
      select jsonb_agg(row_to_json(x) order by x.revenue_centavos desc)
      from (
        select s.id as staff_id, s.name, count(*) as transactions, sum(t.total_centavos) as revenue_centavos, sum(t.item_count) as items
        from public._dash_txns(v_business, p_from, p_to, p_event_id) t
        join public.staff s on s.id = t.staff_id
        group by s.id, s.name
      ) x
    ), '[]'::jsonb),
    'discounts', coalesce((
      select jsonb_agg(row_to_json(x) order by x.amount_centavos desc)
      from (
        select coalesce(discount_reason, '—') as reason, count(*) as transactions, sum(discount_centavos) as amount_centavos
        from public._dash_txns(v_business, p_from, p_to, p_event_id)
        where discount_centavos > 0
        group by 1
      ) x
    ), '[]'::jsonb),
    -- Events in scope: the chosen event, or events whose dates overlap the range or that had sales in it.
    'sell_through', coalesce((
      select jsonb_agg(row_to_json(x) order by x.event_starts_on desc, x.rate desc nulls last)
      from (
        select e.id as event_id, e.name as event_name, e.starts_on as event_starts_on, e.status as event_status,
               p.name as product, ep.starting_stock + coalesce(r.restocked, 0) as stocked,
               coalesce(s.sold, 0) as sold, ep.sold_out_at,
               case when ep.starting_stock + coalesce(r.restocked, 0) > 0
                    then round(coalesce(s.sold, 0)::numeric / (ep.starting_stock + coalesce(r.restocked, 0)), 4) end as rate,
               (select min(t.client_created_at) from public.transactions t where t.event_id = e.id and t.status = 'completed') as first_sale_at
        from public.events e
        join public.event_products ep on ep.event_id = e.id
        join public.products p on p.id = ep.product_id
        left join lateral (select sum(quantity_change) as restocked from public.stock_adjustments a
                           where a.event_product_id = ep.id and a.reason = 'restock') r on true
        left join lateral (select sum(c.quantity) as sold from public.transaction_line_components c
                           join public.transactions t on t.id = c.transaction_id and t.status = 'completed'
                           where c.event_product_id = ep.id) s on true
        where e.business_id = v_business
          and (case when p_event_id is not null then e.id = p_event_id
                    else (e.starts_on <= coalesce(v_to_date, e.starts_on) and e.ends_on >= coalesce(v_from_date, e.ends_on))
                         or exists (select 1 from public._dash_txns(v_business, p_from, p_to, null) t where t.event_id = e.id) end)
      ) x
    ), '[]'::jsonb),
    'waste', (
      select jsonb_build_object(
        'waste_cost_centavos', coalesce(sum(-a.quantity_change * a.unit_cost_centavos) filter (where a.reason = 'waste'), 0),
        'staff_meal_cost_centavos', coalesce(sum(-a.quantity_change * a.unit_cost_centavos) filter (where a.reason = 'staff_meal'), 0),
        'giveaway_cost_centavos', coalesce(sum(-a.quantity_change * a.unit_cost_centavos) filter (where a.reason = 'giveaway'), 0),
        'waste_units', coalesce(sum(-a.quantity_change) filter (where a.reason = 'waste'), 0)
      )
      from public.stock_adjustments a
      where a.business_id = v_business
        and (p_event_id is null or a.event_id = p_event_id)
        and (p_event_id is not null or ((p_from is null or a.created_at >= p_from) and (p_to is null or a.created_at < p_to)))
    ),
    'unsold', (
      select jsonb_build_object(
        'unsold_cost_centavos', coalesce(sum(ep.closing_stock * ep.closing_unit_cost), 0),
        'unsold_units', coalesce(sum(ep.closing_stock), 0)
      )
      from public.event_products ep join public.events e on e.id = ep.event_id
      where e.business_id = v_business and e.status = 'closed'
        and (case when p_event_id is not null then e.id = p_event_id
                  else (p_from is null or e.closed_at >= p_from) and (p_to is null or e.closed_at < p_to) end)
    ),
    'sync', jsonb_build_object(
      'last_synced_at', (select max(synced_at) from public.transactions where business_id = v_business),
      'device_last_seen_at', (select max(last_seen_at) from public.device_heartbeats where business_id = v_business),
      'device_unsynced_count', (select sum(unsynced_count) from public.device_heartbeats where business_id = v_business)
    )
  );
end $$;

revoke all on function public._dash_txns(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.dashboard_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.dashboard_report(timestamptz, timestamptz, uuid) to authenticated;
