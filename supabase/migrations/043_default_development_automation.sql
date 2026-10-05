-- Creating an owned Supremo project authorizes its full development profile.
-- Install the grant and its audit in the same transaction as the project: a
-- failed grant must never leave a successfully created but unusable project.
-- No backfill: existing restrictions, revocations and production stay intact.
CREATE FUNCTION public.initialize_project_development_automation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- The projects INSERT policy checks ownership before this trigger runs.
  -- Keep the identity boundary explicit even for privileged inserts carrying
  -- a user session. Service provisioning without a user JWT remains supported.
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'project not owned';
  END IF;

  PERFORM public.save_project_automation_policy(
    NEW.user_id, NEW.id, 'development', NULL,
    jsonb_build_object(
      'enabled', true,
      'capabilities', jsonb_build_array(
        'data.read', 'data.insert', 'data.update', 'data.upsert', 'data.delete', 'schema.migrate',
        'auth.read', 'auth.configure', 'auth.users', 'auth.invite', 'auth.roles', 'auth.sessions',
        'functions.read', 'functions.deploy', 'functions.remove', 'functions.hooks',
        'jobs.read', 'jobs.manage', 'jobs.run',
        'storage.read', 'storage.manage', 'storage.write', 'storage.delete',
        'integrations.read', 'integrations.configure', 'integrations.invoke',
        'credentials.use', 'engine.update', 'engine.repair'
      ),
      'resources', '[]'::jsonb,
      'deviceIds', '[]'::jsonb,
      'maxRows', 25,
      'maxOperationsPerHour', 60
    )
  );
  RETURN NEW;
END;
$$;

-- Only a legitimate INSERT on projects can invoke this fixed-scope trigger.
-- Agents still need a valid device/project grant and a verified development
-- environment at execution; this does not grant access to other projects.
REVOKE ALL ON FUNCTION public.initialize_project_development_automation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER projects_initialize_development_automation
  AFTER INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.initialize_project_development_automation();
