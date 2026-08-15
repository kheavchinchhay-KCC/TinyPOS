-- ============================================================================
-- Tiny POS · Step 46.4.21
-- Product and leave-media workflow repair
--
-- Run once after Step 52. This migration is additive and does not replace or
-- rerun any earlier migration.
--
-- Repairs legacy Cloudinary records that already contain a valid delivery URL
-- but are missing the public ID used for overwrite/delete operations.
-- ============================================================================

begin;

create schema if not exists private;

create or replace function private.cloudinary_public_id_from_url(p_url text)
returns text
language plpgsql
immutable
as $$
declare
  v_path text;
begin
  if nullif(trim(coalesce(p_url, '')), '') is null then
    return null;
  end if;

  if trim(p_url) !~* '^https?://res\.cloudinary\.com/[^/]+/image/upload/' then
    return null;
  end if;

  v_path := split_part(trim(p_url), '/image/upload/', 2);
  v_path := split_part(v_path, '?', 1);
  v_path := split_part(v_path, '#', 1);

  -- Normal Cloudinary delivery URLs contain a version segment. Everything
  -- after it is the public ID plus the rendered file extension.
  if v_path ~ '^v[0-9]+/' then
    v_path := regexp_replace(v_path, '^v[0-9]+/', '');
  elsif v_path ~ '/v[0-9]+/' then
    v_path := regexp_replace(v_path, '^.*/v[0-9]+/', '');
  end if;

  -- A legacy transformed URL can have a transformation segment without a
  -- version. Remove the known transformation prefix only in that case.
  if v_path !~ '^v[0-9]+/' and split_part(v_path, '/', 1) ~ '(^|,)(f_|q_|c_|g_|w_|h_|ar_|dpr_)' then
    v_path := regexp_replace(v_path, '^[^/]+/', '');
  end if;

  v_path := regexp_replace(v_path, '\.[A-Za-z0-9]+$', '');
  return nullif(trim(v_path), '');
end;
$$;

-- Product media columns exist in the normal Tiny POS schema. IF NOT EXISTS
-- keeps this patch safe for databases created from an earlier partial build.
alter table if exists public.product_images
  add column if not exists cloudinary_public_id text;
alter table if exists public.product_images
  add column if not exists secure_url text;

-- Normalize valid Cloudinary URLs to HTTPS without changing any non-Cloudinary
-- or externally hosted image record.
update public.product_images
set secure_url = regexp_replace(trim(secure_url), '^http://', 'https://', 'i')
where secure_url ~* '^http://res\.cloudinary\.com/';

-- Fill one missing public ID per organization/public-ID pair. The ranking and
-- NOT EXISTS guard avoid unique-key conflicts when duplicate legacy rows exist.
with candidates as (
  select
    pi.id,
    pi.organization_id,
    private.cloudinary_public_id_from_url(pi.secure_url) as derived_public_id,
    row_number() over (
      partition by pi.organization_id,
        private.cloudinary_public_id_from_url(pi.secure_url)
      order by pi.is_primary desc nulls last,
        pi.sort_order nulls last,
        pi.created_at nulls last,
        pi.id
    ) as candidate_rank
  from public.product_images pi
  where nullif(trim(coalesce(pi.cloudinary_public_id, '')), '') is null
    and private.cloudinary_public_id_from_url(pi.secure_url) is not null
)
update public.product_images pi
set cloudinary_public_id = candidates.derived_public_id
from candidates
where pi.id = candidates.id
  and candidates.candidate_rank = 1
  and not exists (
    select 1
    from public.product_images existing
    where existing.organization_id = pi.organization_id
      and existing.id <> pi.id
      and existing.cloudinary_public_id = candidates.derived_public_id
  );

-- Keep exactly one preferred primary image when legacy imports marked several
-- photos as primary. No image is deleted.
with ranked as (
  select
    id,
    row_number() over (
      partition by product_id
      order by is_primary desc nulls last,
        sort_order nulls last,
        created_at nulls last,
        id
    ) as image_rank
  from public.product_images
)
update public.product_images pi
set is_primary = (ranked.image_rank = 1)
from ranked
where pi.id = ranked.id
  and coalesce(pi.is_primary, false) is distinct from (ranked.image_rank = 1);

-- Leave attachments already save both fields in Step 47. These ALTER/UPDATE
-- statements repair partial installations and older valid Cloudinary links.
alter table if exists public.staff_leave_requests
  add column if not exists image_url text;
alter table if exists public.staff_leave_requests
  add column if not exists image_public_id text;

update public.staff_leave_requests
set image_url = regexp_replace(trim(image_url), '^http://', 'https://', 'i')
where image_url ~* '^http://res\.cloudinary\.com/';

update public.staff_leave_requests
set image_public_id = private.cloudinary_public_id_from_url(image_url)
where nullif(trim(coalesce(image_public_id, '')), '') is null
  and private.cloudinary_public_id_from_url(image_url) is not null;

comment on function private.cloudinary_public_id_from_url(text) is
  'Extracts a Cloudinary image public ID from a valid delivery URL for legacy media repair.';

commit;
