-- Creates the database that the automated tests run against.
--
-- Postgres runs everything in /docker-entrypoint-initdb.d once, the first time
-- the data directory is empty. So this file only takes effect on a *fresh*
-- volume: after `docker compose down -v`, or on a machine that has never
-- started the stack. On an existing volume it is simply never read.
--
-- That is why the test bootstrap (tests/setup/global-setup.ts) also creates the
-- database when it is missing. This file is the declaration that the stack has
-- two databases; the bootstrap is what makes an already-running machine work
-- without destroying its development data.
--
-- Owned by POSTGRES_USER, because init scripts run as that user.
CREATE DATABASE farhand_test;

COMMENT ON DATABASE farhand_test IS
  'Truncated between tests. Never point development at this.';
