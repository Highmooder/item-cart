-- =====================================================================
-- Item cart — security self-check (READ-ONLY: it changes nothing)
-- =====================================================================
-- WHAT: a set of questions you ask your own database to see whether anything
--       is open that shouldn't be. Run it in Supabase → SQL Editor. Run each
--       numbered block on its own (select the block, then Run), and compare
--       with "WHAT GOOD LOOKS LIKE".
-- WHEN: after running every numbered SQL file, again before you launch, and any
--       time you add a table or function.
-- This complements Supabase's own Security Advisor (Advisors → Security
-- Advisor in the dashboard). Run both.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tables with row-level security OFF
-- WHAT GOOD LOOKS LIKE: no rows. Every table in "public" must have it on.
-- ---------------------------------------------------------------------
select tablename
from pg_tables
where schemaname = 'public' and not rowsecurity
order by tablename;


-- ---------------------------------------------------------------------
-- 2. Sensitive functions that ANYONE (not signed in) can run
-- WHAT GOOD LOOKS LIKE: no rows. Admin, vendor, payment and refund
-- functions must never be runnable by the public.
-- ---------------------------------------------------------------------
select p.proname as function_name, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and has_function_privilege('anon', p.oid, 'execute')
  and (
        p.proname like 'admin\_%' escape '\'
     or p.proname like 'vendor\_%' escape '\'
     or p.proname in ('begin_online_payment', 'mark_transaction_paid', 'prepare_refund', 'finish_refund',
                      'abort_refund', 'record_refund_status', 'transaction_json')
      )
order by p.proname;


-- ---------------------------------------------------------------------
-- 3. Server-only payment and refund functions that a SIGNED-IN customer can run
-- WHAT GOOD LOOKS LIKE: no rows. Only the server (service_role) may run these.
-- ---------------------------------------------------------------------
select p.proname as function_name, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and has_function_privilege('authenticated', p.oid, 'execute')
  and p.proname in ('begin_online_payment', 'mark_transaction_paid', 'prepare_refund', 'finish_refund',
                    'abort_refund', 'record_refund_status', 'transaction_json');


-- ---------------------------------------------------------------------
-- 4. Functions that run with the database owner's rights but don't pin their search path
-- WHAT GOOD LOOKS LIKE: no rows. (Without a pinned search path, such a function
-- can be tricked into running someone else's code.)
-- ---------------------------------------------------------------------
select p.proname as function_name, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as setting where setting like 'search_path=%'
  )
order by p.proname;


-- ---------------------------------------------------------------------
-- 5. What the public (not signed in) can do directly to each table
-- WHAT GOOD LOOKS LIKE: only SELECT, and only on the public catalog tables
-- (schools, categories, vendors, products, settings). Any INSERT, UPDATE or
-- DELETE here deserves a close look.
-- ---------------------------------------------------------------------
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as anyone_can
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public'
group by table_name
order by table_name;


-- ---------------------------------------------------------------------
-- 6. Every row-level security rule
-- WHAT GOOD LOOKS LIKE: rules for writing (INSERT / UPDATE / DELETE / ALL)
-- should mention is_admin() or a user's own id. A write rule that is just
-- "true" lets anyone write: investigate it.
-- ---------------------------------------------------------------------
select tablename, policyname, cmd as applies_to, roles, qual as using_rule, with_check
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;


-- ---------------------------------------------------------------------
-- 7. File storage: buckets and who can change files
-- WHAT GOOD LOOKS LIKE: a public bucket is fine for product photos (anyone may
-- LOOK), but only admins (or the owner of a file) may upload, update or delete.
-- ---------------------------------------------------------------------
select id, name, public from storage.buckets order by name;

select policyname, cmd as applies_to, roles, qual as using_rule, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by cmd, policyname;


-- ---------------------------------------------------------------------
-- 8. Who is an admin
-- WHAT GOOD LOOKS LIKE: only you (and anyone you chose on purpose).
-- ---------------------------------------------------------------------
select a.user_id, u.email, u.created_at
from admins a
join auth.users u on u.id = a.user_id
order by u.created_at;


-- ---------------------------------------------------------------------
-- 9. Is anything waiting in the vendor application queue that looks like spam?
-- (Not a security hole, just a quick look at the newest applications.)
-- ---------------------------------------------------------------------
select id, store_name, email, status, submitted_at
from vendor_applications
order by submitted_at desc
limit 20;
