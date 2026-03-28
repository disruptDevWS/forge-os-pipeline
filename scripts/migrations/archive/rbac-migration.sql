-- RBAC Migration: User Roles + Audit Access Control
-- All statements idempotent (safe to re-run)
-- Run in Supabase SQL Editor or via `run-migration.mjs`

-- ============================================================
-- a. Create app_role enum + user_roles table + has_role()
--    (idempotent — skips if already exist)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role' AND typnamespace = 'public'::regnamespace) THEN
    CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
  END IF;
END $$;

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'super_admin';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'temp';

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Users can read their own roles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_roles' AND policyname = 'Users can view own roles'
  ) THEN
    CREATE POLICY "Users can view own roles"
      ON public.user_roles FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;
END $$;

-- Super admins can manage all roles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_roles' AND policyname = 'Super admins can manage roles'
  ) THEN
    CREATE POLICY "Super admins can manage roles"
      ON public.user_roles FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- ============================================================
-- b. Create audit_access table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by UUID NOT NULL REFERENCES auth.users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (audit_id, user_id)
);

ALTER TABLE public.audit_access ENABLE ROW LEVEL SECURITY;

-- Super admins can see all access grants
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'audit_access' AND policyname = 'Super admins can view all audit_access'
  ) THEN
    CREATE POLICY "Super admins can view all audit_access"
      ON public.audit_access FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin'));
  END IF;
END $$;

-- Users can see their own access grants
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'audit_access' AND policyname = 'Users can view own audit_access'
  ) THEN
    CREATE POLICY "Users can view own audit_access"
      ON public.audit_access FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;
END $$;

-- Super admins can insert/update/delete audit_access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'audit_access' AND policyname = 'Super admins can manage audit_access'
  ) THEN
    CREATE POLICY "Super admins can manage audit_access"
      ON public.audit_access FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_access_user_id ON public.audit_access(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_access_audit_id ON public.audit_access(audit_id);

-- ============================================================
-- c. Create can_view_audit() function
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_view_audit(_audit_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- super_admin sees everything
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
    -- audit owner
    OR EXISTS (SELECT 1 FROM audits WHERE id = _audit_id AND user_id = auth.uid())
    -- granted access (not revoked, not expired)
    OR EXISTS (
      SELECT 1 FROM audit_access
      WHERE audit_id = _audit_id
        AND user_id = auth.uid()
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    )
$$;

-- ============================================================
-- d. Add SELECT policies to all audit-related tables
--    DO NOT drop existing policies — Postgres ORs multiple
--    SELECT policies, so both owner + can_view_audit work.
--    Skips tables that don't exist yet (safe to re-run after
--    future migrations create them).
-- ============================================================

DO $$
DECLARE
  _tbl TEXT;
  _col TEXT;
  _pol TEXT;
BEGIN
  -- (table_name, audit_id_column)
  FOR _tbl, _col IN
    VALUES
      -- Tables confirmed to exist (2026-03-10)
      ('audits',                       'id'),
      ('audit_assumptions',            'audit_id'),
      ('audit_clusters',               'audit_id'),
      ('audit_keywords',               'audit_id'),
      -- audit_raw_payloads, share_access_log excluded (unverified schema)
      ('audit_reports',                'audit_id'),
      ('audit_rollups',                'audit_id'),
      ('audit_snapshots',              'audit_id'),
      ('audit_topic_competitors',      'audit_id'),
      ('audit_topic_dominance',        'audit_id'),
      ('agent_architecture_blueprint', 'audit_id'),
      ('agent_architecture_pages',     'audit_id'),
      ('agent_implementation_pages',   'audit_id'),
      ('agent_runs',                   'audit_id'),
      ('agent_technical_pages',        'audit_id'),
      ('baseline_snapshots',           'audit_id'),
      ('client_profiles',              'audit_id'),
      ('execution_pages',              'audit_id'),
      ('oscar_requests',               'audit_id'),
      ('pam_requests',                 'audit_id')
  LOOP
    _pol := 'Granted users can view ' || _tbl;

    -- Skip if table does not exist
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = _tbl
    ) THEN
      RAISE NOTICE 'Skipping % — table does not exist', _tbl;
      CONTINUE;
    END IF;

    -- Skip if policy already exists
    IF EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = _tbl AND policyname = _pol
    ) THEN
      RAISE NOTICE 'Skipping % — policy already exists', _tbl;
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.can_view_audit(%I))',
      _pol, _tbl, _col
    );
    RAISE NOTICE 'Created policy on %', _tbl;
  END LOOP;
END $$;

-- ============================================================
-- e. Seed super_admin role for Matt
-- ============================================================

INSERT INTO public.user_roles (user_id, role)
SELECT id, 'super_admin'::app_role
FROM auth.users WHERE email = 'matt@forgegrowth.ai'
ON CONFLICT (user_id, role) DO NOTHING;
