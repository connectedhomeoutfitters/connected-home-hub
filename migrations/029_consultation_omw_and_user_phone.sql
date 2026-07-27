-- "On my way" tracking + staff phone numbers.
--
-- consultations.on_the_way_sent_at: when the consultant sent the "on my way" heads-up to
--   the customer. Lets the Consultations list show a sent state (and avoid an accidental
--   re-send) instead of an always-active button with no feedback.
--
-- users.phone: a contact number per staff member, so the "on my way" email can tell the
--   customer who's coming and how to reach them. Falls back to the company phone
--   (company_settings.phone) when a staff member has none on file.

ALTER TABLE consultations ADD COLUMN on_the_way_sent_at DATETIME NULL;

ALTER TABLE users ADD COLUMN phone VARCHAR(50) NULL AFTER name;
