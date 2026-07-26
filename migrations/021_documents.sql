-- General document storage — contracts, permits, plans, signed PDFs, etc., attached to a
-- customer and optionally tagged to a specific job. Mirrors the consultation_photos /
-- subcontractor_documents pattern: files live on disk under uploads/documents/<customer_id>/
-- and are streamed only through an authenticated route, never express.static (they can
-- hold contracts / PII).

CREATE TABLE documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  job_id INT NULL,
  category VARCHAR(50) NULL,           -- contract / permit / plan / photo / other
  filename VARCHAR(255) NOT NULL,       -- stored name on disk
  original_name VARCHAR(255) NULL,
  mime_type VARCHAR(100) NULL,
  size_bytes INT NULL,
  notes VARCHAR(500) NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id),
  INDEX idx_documents_customer (customer_id),
  INDEX idx_documents_job (job_id)
);
