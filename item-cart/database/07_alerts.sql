-- =====================================================================
-- Item cart — Phase 5: message alerts
-- Run AFTER 06_chat.sql.
-- =====================================================================
-- WHAT: (1) an "unread messages" count that powers the badge in the site
--       header, and (2) a small table that stops the email alerts from
--       sending one email per message.
-- The emails themselves are sent by the Edge Function in
-- supabase/functions/notify-new-message (see ALERTS_SETUP.md).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. UNREAD COUNT (customer chats + any store inboxes the person manages)
-- ---------------------------------------------------------------------
-- JS: supabase.rpc('get_unread_count')  →  a number
create or replace function get_unread_count()
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select (
    -- vendor replies waiting in the person's own chats
    (select count(*)
       from messages m
       join conversations c on c.id = m.conversation_id
      where c.customer_id = auth.uid()
        and m.sender_role = 'vendor'
        and m.created_at > coalesce(c.customer_last_read_at, '-infinity'::timestamptz))
    +
    -- customer messages waiting in stores the person manages
    (select count(*)
       from messages m
       join conversations c on c.id = m.conversation_id
      where m.sender_role = 'customer'
        and is_vendor_member(c.vendor_id)
        and m.created_at > coalesce(c.vendor_last_read_at, '-infinity'::timestamptz))
  )::integer;
$$;

revoke execute on function get_unread_count() from public, anon;
grant  execute on function get_unread_count() to authenticated;


-- ---------------------------------------------------------------------
-- 2. EMAIL THROTTLE
-- ---------------------------------------------------------------------
-- Remembers when we last emailed someone about a conversation, so a
-- fast back-and-forth sends one email, not twenty. Only the Edge Function
-- (using the service key) can touch this table.
create table if not exists chat_notifications (
  conversation_id uuid not null references conversations(id) on delete cascade,
  recipient_id    uuid not null references auth.users(id) on delete cascade,
  last_sent_at    timestamptz not null default now(),
  primary key (conversation_id, recipient_id)
);

alter table chat_notifications enable row level security;   -- no policies: closed to the API
revoke all on chat_notifications from anon, authenticated;
