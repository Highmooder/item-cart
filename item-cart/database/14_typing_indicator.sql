-- =====================================================================
-- 14_typing_indicator.sql  —  live "is typing" dots and instant "Seen" ticks
-- =====================================================================
-- WHAT: lets the two people in a conversation see when the other one is
--       typing, and see their ticks turn to "Seen" instantly. The signals
--       travel over Supabase Realtime (Broadcast) on a private channel called
--       typing-<conversation id>.  NOTHING is stored in your database, so it
--       costs no storage. (What has been read is already stored by 06_chat.sql.)
-- WHY:  a private channel needs a rule saying who may join. Without this
--       file, joining is refused: the dots never appear and the ticks update
--       on the next refresh instead of instantly. Messages keep working.
-- WHO:  only the customer of that conversation, and accounts linked to that
--       conversation's store, can listen or send. Nobody else.
-- RUN:  once, in Supabase → SQL Editor, after 06_chat.sql.
-- =====================================================================

drop policy if exists "chat members can listen for typing" on realtime.messages;
drop policy if exists "chat members can send typing"       on realtime.messages;

create policy "chat members can listen for typing"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1
    from public.conversations c
    where ('typing-' || c.id::text) = (select realtime.topic())
      and (c.customer_id = auth.uid() or public.is_vendor_member(c.vendor_id))
  )
);

create policy "chat members can send typing"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1
    from public.conversations c
    where ('typing-' || c.id::text) = (select realtime.topic())
      and (c.customer_id = auth.uid() or public.is_vendor_member(c.vendor_id))
  )
);
