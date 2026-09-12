package repository

import "gorm.io/gorm"

func migrateWorkflowFrameSchema(database *gorm.DB) error {
	statements := []string{
		`DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conrelid = 'workflow_runs'::regclass
				  AND conname = 'workflow_runs_scope_fields_check'
			) THEN
				UPDATE workflow_runs
				SET scope_type = CASE
						WHEN scope_type = 'frame' AND COALESCE(frame_id, '') <> '' AND COALESCE(frame_name, '') <> '' THEN 'frame'
						ELSE 'workflow'
					END,
					frame_id = CASE
						WHEN scope_type = 'frame' AND COALESCE(frame_id, '') <> '' AND COALESCE(frame_name, '') <> '' THEN frame_id
						ELSE ''
					END,
					frame_name = CASE
						WHEN scope_type = 'frame' AND COALESCE(frame_id, '') <> '' AND COALESCE(frame_name, '') <> '' THEN frame_name
						ELSE ''
					END;
				ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_scope_fields_check CHECK (
					(scope_type = 'workflow' AND frame_id = '' AND frame_name = '') OR
					(scope_type = 'frame' AND frame_id <> '' AND frame_name <> '')
				);
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_workflow_runs_scope_latest ON workflow_runs (owner_uid, workflow_id, scope_type, frame_id, created_at DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_workflow_runs_active ON workflow_runs (owner_uid, workflow_id, scope_type, frame_id, created_at DESC, id DESC) WHERE status IN ('pending', 'running', 'stopping', 'attention_required')`,
	}
	for _, statement := range statements {
		if err := database.Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}
