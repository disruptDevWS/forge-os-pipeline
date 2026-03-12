-- Enable RLS on prospects table and restrict to super_admin

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_full_access" ON public.prospects
  FOR ALL
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
