CREATE TABLE public.project_usage_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  target_ref text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','production')),
  hour timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'array' AND jsonb_array_length(metrics) <= 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,target_ref,environment,hour)
);
CREATE INDEX project_usage_snapshots_owner_idx ON public.project_usage_snapshots(user_id);
CREATE INDEX project_usage_snapshots_history_idx ON public.project_usage_snapshots(project_id,observed_at DESC);
ALTER TABLE public.project_usage_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_usage_snapshots FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.project_usage_snapshots TO service_role;
CREATE TRIGGER project_usage_snapshots_updated_at BEFORE UPDATE ON public.project_usage_snapshots FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.project_usage_alert_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  target_ref text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','production')),
  limits jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(limits) = 'array' AND jsonb_array_length(limits) <= 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,target_ref,environment)
);
CREATE INDEX project_usage_alert_settings_owner_idx ON public.project_usage_alert_settings(user_id);
ALTER TABLE public.project_usage_alert_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_usage_alert_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.project_usage_alert_settings TO service_role;
CREATE TRIGGER project_usage_alert_settings_updated_at BEFORE UPDATE ON public.project_usage_alert_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
