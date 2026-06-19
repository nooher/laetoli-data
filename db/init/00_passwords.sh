#!/bin/bash
# =============================================================================
# 00_passwords.sh — set LOGIN-role passwords from env (runs first, before *.sql)
# -----------------------------------------------------------------------------
# The postgres image runs files in /docker-entrypoint-initdb.d in alphanumeric
# order, and shell scripts here have $POSTGRES_PASSWORD / $POSTGRES_USER /
# $POSTGRES_DB available. The 01_roles.sql / 02_auth.sql files create the
# `authenticator` and `laetoli_auth` LOGIN roles withOUT a password (no secrets
# in git). Because this script sorts BEFORE them (00_ < 01_), it pre-creates the
# roles WITH the password; the later CREATE ROLE ... IF NOT EXISTS guards then
# become no-ops. By convention both login roles reuse $POSTGRES_PASSWORD so
# there is a single secret to manage.
#
# Override per-role secrets via AUTHENTICATOR_PASSWORD / LAETOLI_AUTH_PASSWORD;
# otherwise they fall back to POSTGRES_PASSWORD.
#
# NOTE: psql :'var' interpolation cannot be used inside a DO/PL-pgSQL block
# (server-side, never sees psql vars). So we DROP-then-CREATE each role at the
# top level where :'var' is substituted by the psql client. On a fresh initdb
# the roles don't exist yet, so the leading DROP ... IF EXISTS is harmless.
# =============================================================================
set -euo pipefail

AUTHENTICATOR_PASSWORD="${AUTHENTICATOR_PASSWORD:-$POSTGRES_PASSWORD}"
LAETOLI_AUTH_PASSWORD="${LAETOLI_AUTH_PASSWORD:-$POSTGRES_PASSWORD}"
# storage (:9998) + realtime (:9997) each connect AS their own LOGIN role;
# both reuse POSTGRES_PASSWORD by convention (override if you want per-role secrets).
LAETOLI_STORAGE_PASSWORD="${LAETOLI_STORAGE_PASSWORD:-$POSTGRES_PASSWORD}"
LAETOLI_REALTIME_PASSWORD="${LAETOLI_REALTIME_PASSWORD:-$POSTGRES_PASSWORD}"
# admin API (:9996) connects AS laetoli_admin_login — LOGIN + INHERIT (so it picks
# up laetoli_admin's privileges; 06_admin.sql adds membership + BYPASSRLS).
LAETOLI_ADMIN_PASSWORD="${LAETOLI_ADMIN_PASSWORD:-$POSTGRES_PASSWORD}"
# webhooks worker (:9993) holds a dedicated LISTEN session as laetoli_webhooks.
LAETOLI_WEBHOOKS_PASSWORD="${LAETOLI_WEBHOOKS_PASSWORD:-$POSTGRES_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --set=authenticator_pw="$AUTHENTICATOR_PASSWORD" \
     --set=laetoli_auth_pw="$LAETOLI_AUTH_PASSWORD" \
     --set=laetoli_storage_pw="$LAETOLI_STORAGE_PASSWORD" \
     --set=laetoli_realtime_pw="$LAETOLI_REALTIME_PASSWORD" \
     --set=laetoli_admin_pw="$LAETOLI_ADMIN_PASSWORD" \
     --set=laetoli_webhooks_pw="$LAETOLI_WEBHOOKS_PASSWORD" <<-'EOSQL'
	DROP ROLE IF EXISTS authenticator;
	CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD :'authenticator_pw';

	DROP ROLE IF EXISTS laetoli_auth;
	CREATE ROLE laetoli_auth LOGIN NOINHERIT PASSWORD :'laetoli_auth_pw';

	DROP ROLE IF EXISTS laetoli_storage;
	CREATE ROLE laetoli_storage LOGIN NOINHERIT PASSWORD :'laetoli_storage_pw';

	DROP ROLE IF EXISTS laetoli_realtime;
	CREATE ROLE laetoli_realtime LOGIN NOINHERIT PASSWORD :'laetoli_realtime_pw';

	-- INHERIT (not NOINHERIT) so it picks up laetoli_admin's object privileges;
	-- 06_admin.sql adds the laetoli_admin membership + BYPASSRLS attribute.
	DROP ROLE IF EXISTS laetoli_admin_login;
	CREATE ROLE laetoli_admin_login LOGIN INHERIT PASSWORD :'laetoli_admin_pw';

	DROP ROLE IF EXISTS laetoli_webhooks;
	CREATE ROLE laetoli_webhooks LOGIN NOINHERIT PASSWORD :'laetoli_webhooks_pw';
EOSQL

echo "00_passwords.sh: authenticator + laetoli_auth + laetoli_storage + laetoli_realtime + laetoli_admin_login + laetoli_webhooks passwords set."
