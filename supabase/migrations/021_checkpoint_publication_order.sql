-- Local clocks may be skewed. Once a local checkpoint enters publication its
-- created_at becomes server authority, as for checkpoints originally inserted
-- by publish. getLatestKnownCheckpoint must never sort a newly published change
-- behind its own parent. A retry does not restamp an already publishing row.
CREATE OR REPLACE FUNCTION public.stamp_checkpoint_publication_order()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  NEW.created_at = clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_checkpoint_publication_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkpoint_publication_order ON public.checkpoints;
CREATE TRIGGER trg_checkpoint_publication_order
  BEFORE UPDATE ON public.checkpoints
  FOR EACH ROW WHEN (OLD.push_status = 'local' AND NEW.push_status = 'publishing')
  EXECUTE FUNCTION public.stamp_checkpoint_publication_order();
