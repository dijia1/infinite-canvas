package repository

import (
	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func holdWorkflowGeneratedMedia(tx *gorm.DB, owner, requestID string, media model.Media) error {
	var attempt model.WorkflowOutputAttempt
	if err := tx.Where("owner_uid = ? AND request_id = ?", owner, requestID).Limit(1).Find(&attempt).Error; err != nil {
		return err
	}
	if attempt.ID == "" {
		return nil
	}
	var run model.WorkflowRun
	if err := tx.Clauses(clause.Locking{Strength: "KEY SHARE"}).Where("id = ? AND owner_uid = ?", attempt.RunID, owner).First(&run).Error; err != nil {
		return err
	}
	// Running records cannot be deleted. Insert during media creation closes the
	// gap before the scheduler can receive and publish the completed output.
	ref := model.WorkflowMediaRef{OwnerUID: owner, Scope: "run", ScopeID: attempt.RunID, MediaID: media.ID}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ref).Error; err != nil {
		return err
	}
	return recordMediaLifecycle(tx, media, owner, "reference_added", attempt.RunID, "workflow_result_created")
}
