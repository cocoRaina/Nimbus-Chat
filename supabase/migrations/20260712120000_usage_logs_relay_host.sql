-- Record which actual relay served each usage row.
-- `provider` only stores the SLOT ('openrouter' | 'msuicode'); when several
-- relays share the msuicode slot (treegpt one night, camel the next), we
-- can't tell them apart afterward — which is exactly what's needed to
-- attribute cache cold-writes to a specific upstream. relay_host stores the
-- base URL hostname (e.g. 'api.camel-hub.com'), or 'openrouter.ai'.
alter table usage_logs add column if not exists relay_host text;
