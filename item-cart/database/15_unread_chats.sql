-- =====================================================================
-- 15_unread_chats.sql  —  tell the unread badge WHICH chat is unread
-- =====================================================================
-- WHAT: returns the list of chats that have unread messages (which chat,
--       which store inbox, how many). The Messages icon in the header uses
--       it to open that exact chat, and the Messages page uses it to show
--       a count on each inbox tab.
-- WHY:  get_unread_count() (07_alerts.sql) only returns one number, so the
--       badge could say "3" but not where.
-- RUN:  once, in Supabase → SQL Editor, after 06_chat.sql and 07_alerts.sql.
--       Safe to run again. Without it the site still works: the badge shows
--       the total and opens the Messages page.
-- =====================================================================

create or replace function get_unread_chats()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(u) order by u.last_message_at desc), '[]'::jsonb)
  from (
    -- store replies waiting in the person's own chats
    select c.id,
           c.vendor_id       as "vendorId",
           'customer'::text  as "role",
           v.store_name      as "name",
           c.last_message_at,
           count(*)::integer as "unread"
    from conversations c
    join vendors v  on v.id = c.vendor_id
    join messages m on m.conversation_id = c.id
    where c.customer_id = auth.uid()
      and m.sender_role = 'vendor'
      and m.created_at > coalesce(c.customer_last_read_at, '-infinity'::timestamptz)
    group by c.id, c.vendor_id, c.last_message_at, v.store_name

    union all

    -- customer messages waiting in stores the person manages
    select c.id,
           c.vendor_id,
           'vendor'::text,
           coalesce(p.full_name, 'Customer'),
           c.last_message_at,
           count(*)::integer
    from conversations c
    join messages m on m.conversation_id = c.id
    left join profiles p on p.user_id = c.customer_id
    where is_vendor_member(c.vendor_id)
      and m.sender_role = 'customer'
      and m.created_at > coalesce(c.vendor_last_read_at, '-infinity'::timestamptz)
    group by c.id, c.vendor_id, c.last_message_at, p.full_name
  ) u;
$$;

revoke execute on function get_unread_chats() from public, anon;
grant  execute on function get_unread_chats() to authenticated;
