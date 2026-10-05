import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { applicationRolesSchema } from './options'

/** This fixed administrative primitive is intentionally separate from user SQL.
 * app_metadata merges happen in PostgreSQL to preserve concurrent unrelated claims. */
export function authAdministrationSql(
  userId: string,
  roles?: string[],
): string {
  z.string().uuid().parse(userId)
  const revision = randomUUID()
  const patch =
    roles === undefined
      ? undefined
      : JSON.stringify({
          roles: applicationRolesSchema.parse(roles).slice().sort(),
          roles_revision: revision,
        })
  const roleUpdate =
    patch === undefined
      ? ''
      : `UPDATE auth.users SET raw_app_meta_data=pg_catalog.jsonb_set(COALESCE(raw_app_meta_data,'{}'::jsonb),'{supremo}',COALESCE(raw_app_meta_data->'supremo','{}'::jsonb)||pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(patch, 'utf8').toString('hex')}','hex'),'UTF8')::jsonb,true),updated_at=pg_catalog.now() WHERE id='${userId}'::uuid;`
  return `BEGIN; SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s';
 LOCK TABLE auth.users,auth.sessions,auth.refresh_tokens IN SHARE ROW EXCLUSIVE MODE;
 DO $supremo_auth$ DECLARE removed bigint; BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id='${userId}'::uuid) THEN RAISE EXCEPTION 'SUPREMO_AUTH_USER_MISSING'; END IF;
 ${roleUpdate}
 DELETE FROM auth.refresh_tokens WHERE user_id='${userId}';
 DELETE FROM auth.sessions WHERE user_id='${userId}'::uuid;
 GET DIAGNOSTICS removed=ROW_COUNT;
 PERFORM pg_catalog.set_config('supremo.revoked_sessions',removed::text,true);
 END $supremo_auth$;
 SELECT id::text AS "userId",pg_catalog.current_setting('supremo.revoked_sessions')::integer AS "revokedSessions",(SELECT pg_catalog.count(*)::integer FROM auth.sessions WHERE user_id='${userId}'::uuid) AS "remainingSessions"${patch === undefined ? '' : `,raw_app_meta_data->'supremo'->'roles' AS roles,raw_app_meta_data->'supremo'->>'roles_revision' AS revision`} FROM auth.users WHERE id='${userId}'::uuid;
 COMMIT;`
}
