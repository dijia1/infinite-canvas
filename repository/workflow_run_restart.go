package repository

import (
	"errors"
	"fmt"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrWorkflowRunRestartUnavailable = errors.New("workflow run is not ready to restart")
var ErrWorkflowRunRestartConfirmation = errors.New("workflow restart requires confirmation")

type WorkflowRunRestart struct {
	RunID              string
	ConfirmUncertain   bool
	Audit              model.OperationLog
	ClosedImageTaskIDs []string
}

// Admission already holds the owner's workflow lock. Retiring the old run and
// admitting its replacement share one transaction, including task closure audits.
func retireWorkflowRun(tx *gorm.DB, candidate model.WorkflowRun, restart *WorkflowRunRestart) error {
	if !restart.ConfirmUncertain {
		return ErrWorkflowRunRestartConfirmation
	}
	var previous model.WorkflowRun
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ? AND workflow_id = ?", restart.RunID, candidate.OwnerUID, candidate.WorkflowID).First(&previous).Error; err != nil {
		return ErrWorkflowRunNotFound
	}
	if previous.Status != "attention_required" || normalizeWorkflowRunScopeType(previous.ScopeType) != normalizeWorkflowRunScopeType(candidate.ScopeType) || previous.FrameID != candidate.FrameID {
		return ErrWorkflowRunRestartUnavailable
	}
	var active int64
	if err := tx.Model(&model.WorkflowOutputAttempt{}).Where("run_id = ? AND status IN ?", previous.ID, []string{"claimed", "submitting", "running"}).Count(&active).Error; err != nil {
		return err
	}
	if active != 0 {
		return ErrWorkflowRunRestartUnavailable
	}
	var attempts []model.WorkflowOutputAttempt
	if err := tx.Where("run_id = ? AND status = ?", previous.ID, "uncertain").Order("id").Find(&attempts).Error; err != nil {
		return err
	}
	current := candidate.CreatedAt
	message := "用户已确认重新运行，已结束原请求跟进"
	for index, attempt := range attempts {
		if attempt.LeaseUntil != nil && attempt.LeaseUntil.After(current) {
			return ErrGenerationTaskResolutionConflict
		}
		kind, table := "image", "image_generation_tasks"
		if attempt.TaskType == "video" {
			kind, table = "video", "video_generation_tasks"
		}
		taskID := attempt.TaskID
		if taskID == "" {
			var task struct{ ID string }
			if err := tx.Table(table).Where("owner_uid = ? AND client_request_id = ?", candidate.OwnerUID, attempt.RequestID).Limit(1).Find(&task).Error; err != nil {
				return err
			}
			taskID = task.ID
		}
		if taskID != "" {
			audit := restart.Audit
			audit.ID = fmt.Sprintf("%s-%d", audit.ID, index)
			if err := resolveGenerationTask(tx, kind, taskID, candidate.OwnerUID, "close", "", current, 0, 0, audit); err != nil {
				return err
			}
			if kind == "image" {
				restart.ClosedImageTaskIDs = append(restart.ClosedImageTaskIDs, taskID)
			}
		}
		if err := tx.Model(&model.WorkflowOutputAttempt{}).Where("id = ?", attempt.ID).Updates(map[string]any{"status": "failed", "error": message, "finished_at": current, "updated_at": current, "claim_id": "", "lease_until": nil}).Error; err != nil {
			return err
		}
	}
	if err := tx.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND status = ?", previous.ID, "uncertain").Updates(map[string]any{"status": "failed", "error": message, "updated_at": current}).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND status IN ?", previous.ID, []string{"waiting", "ready"}).Updates(map[string]any{"status": "stopped", "updated_at": current}).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.WorkflowStepExecution{}).Where("run_id = ? AND status NOT IN ?", previous.ID, []string{"succeeded", "failed", "blocked", "stopped"}).Update("status", "stopped").Error; err != nil {
		return err
	}
	if err := tx.Model(&previous).Updates(map[string]any{"status": "stopped", "stop_requested": true, "finished_at": current, "updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error; err != nil {
		return err
	}
	return tx.Create(&restart.Audit).Error
}
