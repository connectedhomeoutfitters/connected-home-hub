-- CHO Hub — Migration 034: per-org branding
-- Phase 2 of docs/adr/0001-multi-tenancy.md.
--
-- Until now every tenant rendered Connected Home Outfitters' logo (one shared
-- public/img/logo.png), CHO's accent colour, and CHO's estimate Terms & Conditions.
-- Harmless while CHO was the only org; unacceptable the moment a second contractor
-- signs in. These columns make the whole visible identity per-tenant, with the existing
-- CHO values as the fallback so nothing changes for org 1 until it's overridden.

ALTER TABLE company_settings
  -- Uploaded logo, stored at uploads/logos/<org_id>/<filename>. NULL = use the built-in
  -- default. Served by the PUBLIC route in routes/branding.js — unlike consultation
  -- photos or customer documents, a logo is deliberately public: it has to load inside
  -- an email client with no session.
  ADD COLUMN logo_filename VARCHAR(255) NULL AFTER company_name,
  -- Hex like #0799D6. Overrides --cho-accent, the single variable both app.css and
  -- portal.css derive every themed colour from.
  ADD COLUMN accent_color VARCHAR(7) NULL AFTER logo_filename,
  ADD COLUMN website VARCHAR(255) NULL AFTER email,
  ADD COLUMN license_number VARCHAR(100) NULL AFTER website,
  -- Reply-to for outbound customer email. The envelope sender stays global (one verified
  -- sending domain, so SPF/DKIM keeps working); only the display name and reply-to are
  -- per-tenant. See services/mailer.js.
  ADD COLUMN email_reply_to VARCHAR(255) NULL AFTER license_number,
  -- Per-tenant estimate T&Cs. Stored and rendered as PLAIN TEXT (escaped, with line
  -- breaks preserved) — NOT html. config/estimateTerms.js's built-in default is
  -- author-controlled HTML and stays that way, but an override is tenant-supplied input,
  -- and rendering that unescaped would let an org admin inject script into their own
  -- customers' estimate pages. Plain text removes the question entirely.
  ADD COLUMN terms_override TEXT NULL AFTER email_reply_to;
