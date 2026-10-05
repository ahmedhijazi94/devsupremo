-- A remote refresh may rotate its refresh token before the process can save it.
-- Keep that reservation durable; only reconnecting or a matching completion can
-- clear it. Elapsed time alone must never permit a second remote refresh.
ALTER TABLE public.github_accounts
  ADD COLUMN token_refresh_claim uuid,
  ADD COLUMN token_refresh_started_at timestamptz,
  ADD CONSTRAINT github_accounts_token_refresh_pair CHECK (
    (token_refresh_claim IS NULL) = (token_refresh_started_at IS NULL)
  );
ALTER TABLE public.supabase_accounts
  ADD COLUMN token_refresh_claim uuid,
  ADD COLUMN token_refresh_started_at timestamptz,
  ADD CONSTRAINT supabase_accounts_token_refresh_pair CHECK (
    (token_refresh_claim IS NULL) = (token_refresh_started_at IS NULL)
  );

CREATE FUNCTION public.claim_account_token_refresh(
  p_provider text, p_account_id uuid, p_user_id uuid,
  p_expected_access text, p_claim_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_account_id IS NULL OR p_user_id IS NULL OR p_claim_id IS NULL
    OR p_expected_access IS NULL OR p_expected_access = '' THEN RETURN false; END IF;
  IF p_provider = 'github' THEN
    UPDATE public.github_accounts
      SET token_refresh_claim = p_claim_id, token_refresh_started_at = clock_timestamp()
      WHERE id = p_account_id AND user_id = p_user_id
        AND access_token_encrypted = p_expected_access AND token_refresh_claim IS NULL;
    RETURN FOUND;
  ELSIF p_provider = 'supabase' THEN
    UPDATE public.supabase_accounts
      SET token_refresh_claim = p_claim_id, token_refresh_started_at = clock_timestamp()
      WHERE id = p_account_id AND user_id = p_user_id
        AND access_token_encrypted = p_expected_access AND token_refresh_claim IS NULL;
    RETURN FOUND;
  END IF;
  RETURN false;
END;
$$;

CREATE FUNCTION public.finish_account_token_refresh(
  p_provider text, p_account_id uuid, p_user_id uuid,
  p_expected_access text, p_claim_id uuid, p_access_token_encrypted text,
  p_refresh_token_encrypted text, p_token_expires_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_account_id IS NULL OR p_user_id IS NULL OR p_claim_id IS NULL
    OR p_expected_access IS NULL OR p_expected_access = ''
    OR p_access_token_encrypted IS NULL OR p_access_token_encrypted = ''
    OR p_refresh_token_encrypted = '' THEN RETURN false; END IF;
  IF p_provider = 'github' THEN
    UPDATE public.github_accounts
      SET access_token_encrypted = p_access_token_encrypted,
        refresh_token_encrypted = p_refresh_token_encrypted,
        token_expires_at = p_token_expires_at,
        token_refresh_claim = NULL, token_refresh_started_at = NULL
      WHERE id = p_account_id AND user_id = p_user_id
        AND access_token_encrypted = p_expected_access AND token_refresh_claim = p_claim_id;
    RETURN FOUND;
  ELSIF p_provider = 'supabase' THEN
    UPDATE public.supabase_accounts
      SET access_token_encrypted = p_access_token_encrypted,
        refresh_token_encrypted = p_refresh_token_encrypted,
        token_expires_at = p_token_expires_at,
        token_refresh_claim = NULL, token_refresh_started_at = NULL
      WHERE id = p_account_id AND user_id = p_user_id
        AND access_token_encrypted = p_expected_access AND token_refresh_claim = p_claim_id;
    RETURN FOUND;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_account_token_refresh(text,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_account_token_refresh(text,uuid,uuid,text,uuid,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_token_refresh(text,uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_account_token_refresh(text,uuid,uuid,text,uuid,text,text,timestamptz) TO service_role;

COMMENT ON FUNCTION public.claim_account_token_refresh(text,uuid,uuid,text,uuid) IS
  'Server-only durable refresh reservation scoped to provider, account, owner and ciphertext; never reclaimed by age.';
COMMENT ON FUNCTION public.finish_account_token_refresh(text,uuid,uuid,text,uuid,text,text,timestamptz) IS
  'Atomically persists a rotated token pair and clears only the matching refresh reservation.';
