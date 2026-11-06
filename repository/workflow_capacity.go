package repository

import (
	"errors"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrWorkflowCapacity   = errors.New("workflow generation capacity is full")
	ErrGenerationTaskBusy = errors.New("generation task state is being updated")
)

// Uncertain work retains per-run protection, but releases global scheduling
// capacity. Resuming it reserves global capacity before restarting its worker.
func reserveWorkflowTaskCapacity(tx *gorm.DB, taskType, taskID, owner string, globalLimit int, current time.Time) error {
	if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", workflowSchedulerAdvisoryLock).Error; err != nil {
		return err
	}
	var attempt model.WorkflowOutputAttempt
	result := tx.Where("owner_uid = ? AND task_type = ? AND task_id = ? AND status = ?", owner, taskType, taskID, "uncertain").Limit(1).Find(&attempt)
	if result.Error != nil || result.RowsAffected == 0 {
		return result.Error
	}
	var run model.WorkflowRun
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", attempt.RunID).First(&run).Error; err != nil {
		return err
	}
	var active int64
	if err := tx.Model(&model.WorkflowOutputAttempt{}).Where("status IN ?", []string{"claimed", "submitting", "running"}).Count(&active).Error; err != nil {
		return err
	}
	if active >= int64(globalLimit) {
		return ErrWorkflowCapacity
	}
	result = tx.Model(&model.WorkflowOutputAttempt{}).
		Where("id = ? AND status = 'uncertain' AND (lease_until IS NULL OR lease_until <= ?)", attempt.ID, current).
		Updates(map[string]any{"status": "running", "error": "", "next_poll_at": current, "updated_at": current})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrGenerationTaskBusy
	}
	if err := tx.Model(&model.WorkflowOutputExecution{}).
		Where("run_id = ? AND node_id = ? AND slot_id = ? AND attempt = ?", attempt.RunID, attempt.NodeID, attempt.SlotID, attempt.Attempt).
		Updates(map[string]any{"status": "running", "error": "", "updated_at": current}).Error; err != nil {
		return err
	}
	return tx.Model(&run).Updates(map[string]any{"updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error
}
