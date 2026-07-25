-- CHO Hub — add Google OAuth as a second staff login method alongside local/bcrypt.
-- Staff rows must already exist (created via scripts/create-admin.js); Google sign-in
-- only attaches google_id to a matching existing user by email, it never creates one.
ALTER TABLE users
  MODIFY COLUMN password_hash VARCHAR(255) NULL,
  ADD COLUMN google_id VARCHAR(100) NULL UNIQUE AFTER email,
  ADD COLUMN avatar_url VARCHAR(500) NULL AFTER name,
  ADD COLUMN last_login TIMESTAMP NULL;
