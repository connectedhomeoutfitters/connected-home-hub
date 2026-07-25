-- Consultation lifecycle rework: 'draft' becomes 'scheduled' (appointment set,
-- site visit not yet conducted). Adds 'on_hold' and 'cancelled' so staff can defer
-- or drop a consultation after the visit instead of it always moving straight to
-- an estimate. 'completed' is unchanged (site visit conducted and saved).
UPDATE consultations SET status = 'scheduled' WHERE status = 'draft';

ALTER TABLE consultations
  MODIFY COLUMN status ENUM('scheduled', 'completed', 'on_hold', 'cancelled') NOT NULL DEFAULT 'scheduled';
