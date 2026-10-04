-- Communities: announcement groups get kind 'community'; groups inside a community remember its name.
-- my_role caches this number's role in admins-only groups ('superadmin' | 'admin' | 'participant').
alter table wa_groups add column community text;
alter table wa_groups add column my_role   text;
alter table wa_groups add column role_checked_at timestamptz;
