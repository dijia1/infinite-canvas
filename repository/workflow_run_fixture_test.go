package repository

import (
	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// createWorkflowRunFixture seeds historical/runtime rows without exposing a
// second production write path around AdmitWorkflowRun.
func createWorkflowRunFixture(run model.WorkflowRun, steps []model.WorkflowStepExecution, outputs []model.WorkflowOutputExecution, mediaIDs []string) (model.WorkflowRun, bool, error) {
	database, err := DB()
	if err != nil {
		return model.WorkflowRun{}, false, err
	}
	inserted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_uid"}, {Name: "request_id"}}, DoNothing: true}).Create(&run)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			existing := model.WorkflowRun{}
			if err := tx.Where("owner_uid = ? AND request_id = ?", run.OwnerUID, run.RequestID).First(&existing).Error; err != nil {
				return err
			}
			run = existing
			return nil
		}
		inserted = true
		if len(steps) > 0 {
			if err := tx.Create(&steps).Error; err != nil {
				return err
			}
		}
		if len(outputs) > 0 {
			if err := tx.Create(&outputs).Error; err != nil {
				return err
			}
		}
		return ReplaceWorkflowMediaRefs(tx, run.OwnerUID, "run", run.ID, mediaIDs)
	})
	return run, inserted, err
}
