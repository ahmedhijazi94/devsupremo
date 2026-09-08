-- Support ownership filters and referential actions without table-wide scans.
-- Additive only: no data rewrites, destructive DDL, or privilege changes.
CREATE INDEX IF NOT EXISTS idx_oauth_states_project_id ON public.oauth_states(project_id);
CREATE INDEX IF NOT EXISTS idx_secret_requests_user_id ON public.secret_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_project_runtimes_user_id ON public.project_runtimes(user_id);
CREATE INDEX IF NOT EXISTS idx_validation_runs_user_id ON public.validation_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id ON public.agent_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_device_id ON public.checkpoints(device_id);
CREATE INDEX IF NOT EXISTS idx_restore_requested_by ON public.checkpoint_restore_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_restore_result_checkpoint_id ON public.checkpoint_restore_requests(result_checkpoint_id);
