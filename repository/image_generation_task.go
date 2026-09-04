package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func CreateImageGenerationTask(item model.ImageGenerationTask) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	result := database.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_uid"}, {Name: "client_request_id"}}, DoNothing: true}).Create(&item)
	if result.Error != nil {
		return model.ImageGenerationTask{}, false, result.Error
	}
	if result.RowsAffected > 0 {
		return item, true, nil
	}
	existing, found, err := GetImageGenerationTaskByClientRequest(item.OwnerUID, item.ClientRequestID)
	return existing, false, firstImageTaskLookupError(found, err)
}

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

func ClaimNextImageGenerationTask(staleBefore, updatedAt string) (model.ImageGenerationTask, bool, error) {
	database, err := DB()
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	var claimed model.ImageGenerationTask
	err = database.Transaction(func(transaction *gorm.DB) error {
		candidate := model.ImageGenerationTask{}
		query := transaction.Where("status = ?", model.ImageTaskQueued)
		if staleBefore != "" {
			query = query.Or("status IN ? AND updated_at < ?", []model.ImageGenerationTaskStatus{model.ImageTaskSubmitting, model.ImageTaskRunning}, staleBefore)
		}
		result := query.Order("created_at asc").Order("id asc").Limit(1).Find(&candidate)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		result = transaction.Model(&model.ImageGenerationTask{}).
			Where("id = ? AND status = ? AND updated_at = ?", candidate.ID, candidate.Status, candidate.UpdatedAt).
			Updates(map[string]any{"status": model.ImageTaskSubmitting, "updated_at": updatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		candidate.Status = model.ImageTaskSubmitting
		candidate.UpdatedAt = updatedAt
		claimed = candidate
		return nil
	})
	if err != nil {
		return model.ImageGenerationTask{}, false, err
	}
	return claimed, claimed.ID != "", nil
}

func UpdateImageGenerationTask(id string, updates map[string]any) error {
	if len(updates) == 0 {
		return nil
	}
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Model(&model.ImageGenerationTask{}).Where("id = ?", id).Updates(updates).Error
}

// SetImageGenerationTaskProviderTaskID moves a claimed image task into its
// polling state and records the upstream task ID in its audit record together.
func SetImageGenerationTaskProviderTaskID(id, operationLogID, providerTaskID, updatedAt string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		if err := transaction.Model(&model.ImageGenerationTask{}).Where("id = ?", id).Updates(map[string]any{
			"provider_task_id": providerTaskID,
			"status":           model.ImageTaskRunning,
			"updated_at":       updatedAt,
		}).Error; err != nil {
			return err
		}
		if operationLogID == "" {
			return nil
		}
		return transaction.Model(&model.OperationLog{}).Where("id = ?", operationLogID).Update("provider_task_id", providerTaskID).Error
	})
}

// RenewImageGenerationTaskLease records that a worker is still actively
// processing a claimed task. Terminal tasks are intentionally never renewed.
func RenewImageGenerationTaskLease(id, updatedAt string) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	result := database.Model(&model.ImageGenerationTask{}).
		Where("id = ? AND status IN ?", id, []model.ImageGenerationTaskStatus{model.ImageTaskSubmitting, model.ImageTaskRunning}).
		Updates(map[string]any{"updated_at": updatedAt})
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
	err = database.Where("status = ? AND finished_at >= ? AND finished_at < ?", model.ImageTaskSucceeded, start, end).
		Order("provider_name asc, provider_id asc, id asc").Find(&items).Error
	return items, err
}

func DeleteImageGenerationTask(id string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Delete(&model.ImageGenerationTask{}, "id = ?", id).Error
}

func firstImageTaskLookupError(found bool, err error) error {
	if err != nil {
		return err
	}
	if !found {
		return errors.New("图片任务创建后未找到记录")
	}
	return nil
}
