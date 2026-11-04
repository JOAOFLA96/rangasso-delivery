-- Etiquetas de validade impressas pela Epson do caixa (via agente), além da impressão pelo navegador.
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check CHECK (kind IN ('original', 'reprint', 'test', 'label'));
ALTER TABLE label_prints ADD COLUMN print_job_id uuid REFERENCES print_jobs(id) ON DELETE SET NULL;
