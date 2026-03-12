-- Geo-Flexibility: Add geo_mode + market_geos to audits table
-- geo_mode determines how locales are interpreted for keyword query construction
-- market_geos stores structured geo data per mode (replaces market_city/market_state reads)

ALTER TABLE public.audits
  ADD COLUMN IF NOT EXISTS geo_mode text NOT NULL DEFAULT 'city'
    CHECK (geo_mode IN ('city', 'metro', 'state', 'national')),
  ADD COLUMN IF NOT EXISTS market_geos jsonb;

-- Backfill existing rows from market_city + market_state
UPDATE public.audits
SET
  geo_mode = 'city',
  market_geos = jsonb_build_object(
    'state', market_state,
    'cities', string_to_array(market_city, ', ')
  )
WHERE market_geos IS NULL;
