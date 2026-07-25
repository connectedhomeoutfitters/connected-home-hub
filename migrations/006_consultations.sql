-- CHO Hub — native on-site consultation/site-survey form, replacing the Google Form
-- (see choHubProject's CLAUDE.md). This is staff-facing, filled during/after the visit
-- (Section 10's fields — installation_complexity, recommended_package, etc. — are the
-- consultant's own assessment, not customer input). lead_id is nullable and unused by
-- any route yet — reserved so a future "Start Consultation" button on the leads table
-- can link back to where the customer came from without a schema change later.
CREATE TABLE consultations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  lead_id INT NULL,
  consultant_id INT NULL,
  status ENUM('draft', 'completed') NOT NULL DEFAULT 'draft',

  -- Section 1: Customer Information (name/phone/email/address come from the linked
  -- customer record — not duplicated here)
  consultation_date DATE NULL,
  referral_source VARCHAR(100) NULL,

  -- Section 2: Property Information
  home_type VARCHAR(100) NULL,
  square_footage VARCHAR(100) NULL,
  number_of_stories VARCHAR(50) NULL,
  year_built VARCHAR(10) NULL,

  -- Section 3: Customer Goals
  services_interested JSON NULL,
  biggest_frustration TEXT NULL,
  priorities JSON NULL,

  -- Section 4: Existing Technology
  internet_provider VARCHAR(255) NULL,
  internet_speed VARCHAR(100) NULL,
  has_mesh_wifi VARCHAR(20) NULL,
  has_security_cameras VARCHAR(20) NULL,
  existing_smart_devices JSON NULL,

  -- Section 5: Wi-Fi Assessment
  wifi_coverage_ratings JSON NULL,
  connectivity_issue_areas JSON NULL,

  -- Section 6: Security & Camera Assessment
  desired_camera_locations JSON NULL,
  camera_wiring_present VARCHAR(20) NULL,
  interested_video_doorbell VARCHAR(20) NULL,
  interested_remote_monitoring VARCHAR(20) NULL,

  -- Section 7: Smart Home Opportunities
  smart_home_interests JSON NULL,
  preferred_smart_platform VARCHAR(50) NULL,

  -- Section 8: Project Details
  desired_timeline VARCHAR(100) NULL,
  budget_range VARCHAR(100) NULL,
  interested_financing VARCHAR(20) NULL,

  -- Section 10: Consultant Notes
  installation_complexity VARCHAR(50) NULL,
  recommended_package VARCHAR(100) NULL,
  recommended_addons JSON NULL,
  consultant_notes TEXT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (consultant_id) REFERENCES users(id),
  INDEX idx_consultations_customer (customer_id)
);

-- Section 9: Site Photos
CREATE TABLE consultation_photos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  consultation_id INT NOT NULL,
  category VARCHAR(100) NULL,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
  INDEX idx_consultation_photos_consultation (consultation_id)
);
