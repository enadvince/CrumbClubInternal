# Crumb Club POS

Internal, offline-first point of sale for Crumb Club pop-ups. Full setup guide and the
"how to run a pop-up day" staff guide are added in the final build phase.

- `supabase/migrations/` — schema, RLS, RPCs (apply with `supabase db push`)
- `supabase/seed.sql` — local dev owner + sample menu
- `npm test` — unit tests · `npm run test:db` — SQL tests against a throwaway Postgres 16
