package repository

import (
	"errors"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrGenerationTaskResolutionConflict = errors.New("generation task no longer needs resolution")

// ResolveGenerationTask changes task state and records the administrator's
// decision in the same transaction. It never submits a provider request.
func ResolveGenerationTask(kind, id, action, providerTaskID string, current time.Time, timeout time.Duration, globalLimit int, audit model.OperationLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	table := "image_generation_tasks"
	if kind == "video" {
		table = "video_generation_tasks"
	}
	status := "failed"
	err = db.Transaction(func(tx *gorm.DB) error {
		var task struct {
			ID, OwnerUID, Status, ProviderTaskID, OperationLogID string
		}
		if err := tx.Table(table).Select("id", "owner_uid", "status", "provider_task_id", "operation_log_id").Where("id = ?", id).Take(&task).Error; err != nil {
			return err
		}
		if task.Status != "uncertain" && task.Status != "paused" {
			return ErrGenerationTaskResolutionConflict
		}
		updates := map[string]any{"claim_id": "", "lease_until": nil}
		message := "管理员已核对并确认失败"
		if action == "attach" {
			if task.ProviderTaskID != "" && task.ProviderTaskID != providerTaskID {
				return ErrGenerationTaskResolutionConflict
			}
			if err := reserveWorkflowTaskCapacity(tx, kind, id, task.OwnerUID, globalLimit, current); err != nil {
				return err
			}
			status, message = "running", ""
			updates["provider_task_id"], updates["deadline"] = providerTaskID, current.Add(timeout)
		}
		updates["status"] = status
		if kind == "image" {
			updates["error_message"], updates["updated_at"], updates["poll_failures"] = message, current.Format(time.RFC3339Nano), 0
			if action == "close" {
				updates["finished_at"] = current.Format(time.RFC3339Nano)
			}
		} else {
			updates["error"], updates["updated_at"], updates["attempts"], updates["next_poll_at"] = message, current, 0, current
			if action == "close" {
				updates["finished_at"] = current
			} else {
				updates["status"] = gorm.Expr("CASE WHEN result_urls_json <> '[]' THEN 'saving' ELSE 'running' END")
			}
		}
		result := tx.Table(table).Where("id = ? AND status = ? AND (lease_until IS NULL OR lease_until <= ?)", id, task.Status, current).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrGenerationTaskResolutionConflict
		}
		if task.OperationLogID != "" {
			operationStatus := model.OperationStatusSubmitted
			if action == "close" {
				operationStatus = model.OperationStatusFailure
			}
			upstreamID := task.ProviderTaskID
			if action == "attach" {
				upstreamID = providerTaskID
			}
			audit.ProviderTaskID = upstreamID
			if err := tx.Model(&model.OperationLog{}).Where("id = ?", task.OperationLogID).Updates(map[string]any{"status": operationStatus, "error_message": message, "provider_task_id": upstreamID}).Error; err != nil {
				return err
			}
		}
		return tx.Create(&audit).Error
	})
	return err
}
