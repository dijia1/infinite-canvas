package repository

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrImageLeaseLost = errors.New("image task lease lost")

// CreateImageGenerationTaskWithOperationLog commits the new task and its
// submitted audit record together. A duplicate client request returns the
// existing task without creating a second operation log.
func CreateImageGenerationTaskWithOperationLog(item model.ImageGenerationTask, operation model.OperationLog) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	created := model.ImageGenerationTask{}
	inserted := false
	err = database.Transaction(func(transaction *gorm.DB) error {
		result := transaction.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_uid"}, {Name: "client_request_id"}}, DoNothing: true}).Create(&item)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 {
			if err := transaction.Create(&operation).Error; err != nil {
				return err
			}
			created = item
			inserted = true
			return nil
		}
		if err := transaction.Where("owner_uid = ? AND client_request_id = ?", item.OwnerUID, item.ClientRequestID).First(&created).Error; err != nil {
			return err
		}
		if !generationRequestHashMatches(created.RequestHash, item.RequestHash) {
			return ErrGenerationRequestConflict
		}
		return nil
	})
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	return created, inserted, nil
}

func GetImageGenerationTask(id string) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	item := model.ImageGenerationTask{}
	err = database.First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.ImageGenerationTask{}, false, nil
	}
	return item, err == nil, err
}

func GetImageGenerationTaskForOwner(id, ownerUID string) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	item := model.ImageGenerationTask{}
	err = database.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.ImageGenerationTask{}, false, nil
	}
	return item, err == nil, err
}

func GetImageGenerationTaskByClientRequest(ownerUID, clientRequestID string) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	item := model.ImageGenerationTask{}
	err = database.Where("owner_uid = ? AND client_request_id = ?", ownerUID, clientRequestID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.ImageGenerationTask{}, false, nil
	}
	return item, err == nil, err
}

func ClaimNextImageGenerationTask(current time.Time, lease time.Duration) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	if lease <= 0 {
		return model.ImageGenerationTask{}, false, errors.New("image task lease must be positive")
	}
	var claimed model.ImageGenerationTask
	err = database.Transaction(func(transaction *gorm.DB) error {
		candidate := model.ImageGenerationTask{}
		result := transaction.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status IN ?", []model.ImageGenerationTaskStatus{model.ImageTaskQueued, model.ImageTaskSubmitting, model.ImageTaskRunning}).
			Where("lease_until IS NULL OR lease_until <= ?", current.UTC()).
			Order("created_at asc").Order("id asc").Limit(1).Find(&candidate)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		claimID := uuid.NewString()
		leaseUntil := current.UTC().Add(lease)
		result = transaction.Model(&model.ImageGenerationTask{}).
			Where("id = ?", candidate.ID).
			Updates(map[string]any{"claim_id": claimID, "lease_until": leaseUntil})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrImageLeaseLost
		}
		candidate.ClaimID = claimID
		candidate.LeaseUntil = &leaseUntil
		claimed = candidate
		return nil
	})
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	return claimed, claimed.ID != "", nil
}

func UpdateClaimedImageGenerationTask(item model.ImageGenerationTask, updates map[string]any) error {
	if len(updates) == 0 {
		return nil
	}
	if item.ClaimID == "" {
		return ErrImageLeaseLost
	}
	database, err := DB()
	if err != nil {
		return err
	}
	result := database.Model(&model.ImageGenerationTask{}).
		Where("id = ? AND claim_id = ? AND lease_until IS NOT NULL AND lease_until > ?", item.ID, item.ClaimID, time.Now().UTC()).
		Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrImageLeaseLost
	}
	return nil
}

// CompleteImageGenerationTask publishes generated media and the terminal task
// state together. The row lock and lease check fence workers that finish after
// their claim has expired or been replaced.
func CompleteImageGenerationTask(item model.ImageGenerationTask, media []model.Media) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		var task model.ImageGenerationTask
		if err := transaction.Clauses(clause.Locking{Strength: "UPDATE"}).First(&task, "id = ?", item.ID).Error; err != nil {
			return err
		}
		current := time.Now().UTC()
		if task.OwnerUID != item.OwnerUID || task.ClaimID == "" || task.ClaimID != item.ClaimID || task.LeaseUntil == nil || !task.LeaseUntil.After(current) || (task.Status != model.ImageTaskSubmitting && task.Status != model.ImageTaskRunning) {
			return ErrImageLeaseLost
		}
		if len(media) == 0 {
			return errors.New("image task result media is empty")
		}
		ids := make([]string, 0, len(media))
		for _, result := range media {
			if result.ID == "" || result.OwnerUID != task.OwnerUID {
				return errors.New("image task result media owner mismatch")
			}
			if err := transaction.Create(&result).Error; err != nil {
				return err
			}
			if err := holdWorkflowGeneratedMedia(transaction, task.OwnerUID, task.ClientRequestID, result); err != nil {
				return err
			}
			if err := recordMediaLifecycle(transaction, result, task.OwnerUID, "created", "", "resource_created"); err != nil {
				return err
			}
			ids = append(ids, result.ID)
		}
		encoded, err := json.Marshal(ids)
		if err != nil {
			return err
		}
		updated := transaction.Model(&model.ImageGenerationTask{}).
			Where("id = ? AND claim_id = ? AND lease_until > ?", task.ID, task.ClaimID, current).
			Updates(map[string]any{
				"status": model.ImageTaskSucceeded, "progress": 100, "result_media_ids_json": string(encoded),
				"error_message": "", "claim_id": "", "lease_until": nil, "updated_at": current.Format(time.RFC3339Nano), "finished_at": current.Format(time.RFC3339Nano),
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrImageLeaseLost
		}
		if task.OperationLogID == "" {
			return nil
		}
		audit := transaction.Model(&model.OperationLog{}).Where("id = ?", task.OperationLogID).Updates(map[string]any{
			"status": model.OperationStatusSuccess, "provider_task_id": task.ProviderTaskID, "media_ids": string(encoded), "error_message": "",
		})
		if audit.Error != nil {
			return audit.Error
		}
		if audit.RowsAffected != 1 {
			return errors.New("image task operation log was not found")
		}
		return nil
	})
}

// SetImageGenerationTaskProviderTaskID moves a claimed image task into its
// polling state and records the upstream task ID in its audit record together.
func SetImageGenerationTaskProviderTaskID(item model.ImageGenerationTask, providerTaskID, updatedAt string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		result := transaction.Model(&model.ImageGenerationTask{}).
			Where("id = ? AND claim_id = ? AND lease_until IS NOT NULL AND lease_until > ? AND status = ? AND provider_task_id = ''", item.ID, item.ClaimID, time.Now().UTC(), model.ImageTaskSubmitting).
			Updates(map[string]any{
				"provider_task_id": providerTaskID,
				"status":           model.ImageTaskRunning,
				"updated_at":       updatedAt,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrImageLeaseLost
		}
		if item.OperationLogID == "" {
			return nil
		}
		return transaction.Model(&model.OperationLog{}).Where("id = ?", item.OperationLogID).Update("provider_task_id", providerTaskID).Error
	})
}

// RenewImageGenerationTaskLease records that a worker is still actively
// processing a claimed task. Terminal tasks are intentionally never renewed.
func RenewImageGenerationTaskLease(item model.ImageGenerationTask, current time.Time, lease time.Duration) (bool, error) {
	if item.ClaimID == "" || lease <= 0 {
		return false, nil
	}
	database, err := DB()
	if err != nil {
		return false, err
	}
	result := database.Model(&model.ImageGenerationTask{}).
		Where("id = ? AND claim_id = ? AND lease_until IS NOT NULL AND lease_until > ? AND status IN ?", item.ID, item.ClaimID, current.UTC(), []model.ImageGenerationTaskStatus{model.ImageTaskQueued, model.ImageTaskSubmitting, model.ImageTaskRunning}).
		Update("lease_until", current.UTC().Add(lease))
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

func ListExpiredTerminalImageGenerationTasks(before string) ([]model.ImageGenerationTask, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.ImageGenerationTask, 0)
	err = database.Where("status IN ? AND finished_at <> '' AND finished_at < ?", []model.ImageGenerationTaskStatus{model.ImageTaskSucceeded, model.ImageTaskFailed}, before).Find(&items).Error
	return items, err
}

func ListSucceededImageGenerationTasksFinishedBetween(start, end string) ([]model.ImageGenerationTask, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.ImageGenerationTask, 0)
	err = database.Select("owner_uid", "provider_id", "provider_name", "resolution", "result_media_ids_json", "amount", "amount_recorded").
		Where("status = ? AND finished_at >= ? AND finished_at < ?", model.ImageTaskSucceeded, start, end).Find(&items).Error
	return items, err
}

// Only select audit-safe columns; provider configuration and saved request data never leave persistence.
func ListImageTasksForOperations(operationIDs []string) ([]model.ImageGenerationTask, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.ImageGenerationTask, 0)
	if len(operationIDs) == 0 {
		return items, nil
	}
	err = database.Select("id", "operation_log_id", "status", "provider_id", "provider_name", "provider_task_id", "quality", "size", "resolution", "output_format", "background", "amount", "error_message").
		Where("operation_log_id IN ?", operationIDs).Find(&items).Error
	return items, err
}

func DeleteImageGenerationTask(id string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Delete(&model.ImageGenerationTask{}, "id = ?", id).Error
}
