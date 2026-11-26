-- Etiquetas de validade impressas pela Epson do caixa (via agente), além da impressão pelo navegador.
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check CHECK (kind IN ('original', 'reprint', 'test', 'label'));
ALTER TABLE label_prints ADD COLUMN print_job_id uuid REFERENCES print_jobs(id) ON DELETE SET NULL;

-- Impressora de etiquetas (TSPL) ligada por USB a um PC com o agente: cada etiqueta usa o sensor de espaço.
ALTER TABLE store_settings
  ADD COLUMN label_device_id uuid REFERENCES print_devices(id) ON DELETE SET NULL,
  ADD COLUMN label_printer_name text NOT NULL DEFAULT '',
  ADD COLUMN label_width_mm numeric(5,1) NOT NULL DEFAULT 50 CHECK (label_width_mm BETWEEN 20 AND 104),
  ADD COLUMN label_height_mm numeric(5,1) NOT NULL DEFAULT 30 CHECK (label_height_mm BETWEEN 15 AND 200),
  ADD COLUMN label_gap_mm numeric(4,1) NOT NULL DEFAULT 4 CHECK (label_gap_mm BETWEEN 0 AND 20),
  ADD COLUMN label_speed integer NOT NULL DEFAULT 2 CHECK (label_speed BETWEEN 1 AND 6),
  ADD COLUMN label_density integer NOT NULL DEFAULT 10 CHECK (label_density BETWEEN 0 AND 15),
  ADD COLUMN label_offset_x_mm numeric(4,1) NOT NULL DEFAULT 0 CHECK (label_offset_x_mm BETWEEN -10 AND 10),
  ADD COLUMN label_offset_y_mm numeric(4,1) NOT NULL DEFAULT 0 CHECK (label_offset_y_mm BETWEEN -10 AND 10),
  ADD COLUMN label_rotate boolean NOT NULL DEFAULT false;

-- Trabalho destinado a um agente específico (o PC onde está a impressora de etiquetas). NULL = qualquer agente.
ALTER TABLE print_jobs ADD COLUMN target_device_id uuid REFERENCES print_devices(id) ON DELETE SET NULL;
