-- 004_model_choice: why the AI router picked the model behind a task's latest answer (JSON: need, model, reasons).
-- Additive only.
ALTER TABLE tasks ADD COLUMN model_choice TEXT;
