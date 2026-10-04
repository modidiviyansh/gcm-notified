-- Round 1 feedback: auto-detected warm-up, WhatsApp limits, channels, generic contact lists.

-- Warm-up details can come from WhatsApp itself ("auto") instead of the admin ("manual").
-- 'pending' = not known yet; detected automatically once the number connects.
alter table wa_numbers add column warmup_source text not null default 'manual';
alter table wa_numbers add column detected      jsonb;           -- last detection result (counts only)
alter table wa_numbers add column detected_at   timestamptz;
alter table wa_numbers add column wa_limits     jsonb;           -- WhatsApp's own messageCapping / reachoutTimelock

-- wa_groups now holds both groups and channels a number can post to
alter table wa_groups add column kind      text not null default 'group';  -- 'group' | 'channel'
alter table wa_groups add column announce  boolean not null default false; -- only admins can post
alter table wa_groups add column role      text;                            -- channel role: OWNER | ADMIN
alter table wa_groups add column source    text not null default 'full';    -- 'full' list or 'chats' fallback

-- Contact lists: optional description
alter table contact_groups add column description text;
