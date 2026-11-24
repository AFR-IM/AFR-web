-- Apply once to an existing D1 database before deploying the owner email Worker.
-- New databases created from schema.sql already include both columns.
ALTER TABLE owner_emails ADD COLUMN pending_email_cipher TEXT;
ALTER TABLE owner_emails ADD COLUMN pending_email_hash TEXT;
