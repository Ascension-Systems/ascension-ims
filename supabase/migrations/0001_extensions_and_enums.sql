-- 0001_extensions_and_enums.sql
-- Ascension Sales Portal — build-order step 1.
--
-- APPLY BY HAND. The Human pastes this file into the Supabase SQL editor, in numeric
-- order, so a person reads every schema change. Nothing in the build applies it.

-- gen_random_uuid() is built in on PG13+; Supabase also ships pgcrypto. No extension needed.

-- Enums rather than text+CHECK: the value sets are fixed by the brief, and an enum makes an
-- out-of-band state literally unrepresentable rather than merely rejected.
CREATE TYPE public.app_role            AS ENUM ('rep', 'admin');
CREATE TYPE public.commitment_state    AS ENUM ('pending', 'confirmed_in_source', 'retired');
CREATE TYPE public.inventory_source    AS ENUM ('quickbooks', 'quickbooks_stub', 'manual_override');
CREATE TYPE public.inventory_authority AS ENUM ('quickbooks', 'portal');

-- 'quickbooks' and 'quickbooks_stub' are distinct values on purpose: the stub must never
-- claim to be the real integration. The UI labels them "QuickBooks" and "QuickBooks (stub)".
-- When the real integration lands it writes 'quickbooks' and the change is visible to every
-- rep.
