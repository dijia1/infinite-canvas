package repository

import (
	"encoding/json"
	"errors"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
)

var ErrVideoLeaseLost = errors.New("video task lease lost")

func GetVideoGenerationTask(id, owner string) (model.VideoGenerationTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoGenerationTask{}, false, err
	}
	var item model.VideoGenerationTask
	err = db.Where("id = ? AND owner_uid = ?", id, owner).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return item, false, nil
	}
	return item, err == nil, err
}
func GetVideoGenerationTaskByClient(owner, client string) (model.VideoGenerationTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoGenerationTask{}, false, err
	}
	var item model.VideoGenerationTask
	err = db.Where("client_request_id = ? AND owner_uid = ?", client, owner).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return item, false, nil
	}
	return item, err == nil, err
}

func CreateVideoGenerationTask(item model.VideoGenerationTask, operation model.OperationLog, inputs []string) (model.VideoGenerationTask, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		// Share sorted media locks with Canvas and retention before publishing task references.
		var media []model.Media
		if len(inputs) > 0 {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id IN ?", inputs).Order("id").Find(&media).Error; err != nil {
				return err
			}
			byID := map[string]model.Media{}
			for _, m := range media {
				byID[m.ID] = m
			}
			for _, id := range inputs {
				m, ok := byID[id]
				if !ok || m.CleanupStatus != model.MediaCleanupActive {
					return ErrCanvasMediaUnavailable
				}
				if m.OwnerUID != item.OwnerUID {
					var count int64
					if err := tx.Model(&model.PublicImage{}).Where("media_id = ?", id).Count(&count).Error; err != nil {
						return err
					}
					if count == 0 {
						return ErrCanvasMediaUnavailable
					}
				}
			}
		}
		result := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_uid"}, {Name: "client_request_id"}}, DoNothing: true}).Create(&item)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			owner, client := item.OwnerUID, item.ClientRequestID
			requestHash := item.RequestHash
			item = model.VideoGenerationTask{}
			if err := tx.Where("owner_uid = ? AND client_request_id = ?", owner, client).First(&item).Error; err != nil {
				return err
			}
			if !generationRequestHashMatches(item.RequestHash, requestHash) {
				return ErrGenerationRequestConflict
			}
			return nil
		}
		return tx.Create(&operation).Error
	})
	return item, err
}

func ClaimNextVideoGenerationTask(current time.Time) (model.VideoGenerationTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoGenerationTask{}, false, err
	}
	var item model.VideoGenerationTask
	err = db.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).Where("status IN ? AND next_poll_at <= ? AND (lease_until IS NULL OR lease_until <= ?)", []string{"queued", "submitting", "running", "saving"}, current, current).Order("next_poll_at,id").Limit(1).Find(&item)
		if result.Error != nil || result.RowsAffected == 0 {
			return result.Error
		}
		item.ClaimID = uuid.NewString()
		until := current.Add(2 * time.Minute)
		item.LeaseUntil = &until
		return tx.Model(&item).Updates(map[string]any{"claim_id": item.ClaimID, "lease_until": until}).Error
	})
	return item, item.ID != "", err
}
func UpdateClaimedVideoTask(item model.VideoGenerationTask, updates map[string]any) error {
	db, err := DB()
	if err != nil {
		return err
	}
	updates["updated_at"] = time.Now().UTC()
	current := time.Now().UTC()
	result := db.Model(&model.VideoGenerationTask{}).Where("id = ? AND claim_id = ? AND lease_until > ?", item.ID, item.ClaimID, current).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrVideoLeaseLost
	}
	return nil
}
func ResumeVideoGenerationTask(id, owner string, current time.Time, timeout time.Duration) error {
	db, err := DB()
	if err != nil {
		return err
	}
	result := db.Model(&model.VideoGenerationTask{}).Where("id = ? AND owner_uid = ? AND status = ? AND provider_task_id <> ''", id, owner, "paused").Updates(map[string]any{"status": gorm.Expr("CASE WHEN result_urls_json <> '[]' THEN 'saving' ELSE 'running' END"), "error": "", "attempts": 0, "deadline": current.Add(timeout), "next_poll_at": current, "lease_until": nil, "claim_id": ""})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("任务不能恢复")
	}
	return nil
}

// Read while media locks are held. Task creation takes these same locks.
func videoTaskReferences(tx *gorm.DB, mediaID string, current time.Time) (bool, error) {
	var count int64
	err := tx.Model(&model.VideoGenerationTask{}).Where("(status NOT IN ? OR (status = ? AND finished_at > ?))", []string{"succeeded", "failed"}, "succeeded", current.Add(-24*time.Hour)).Where("input_media_ids_json::jsonb @> ?::jsonb OR result_media_ids_json::jsonb @> ?::jsonb", mustJSON([]string{mediaID}), mustJSON([]string{mediaID})).Count(&count).Error
	return count > 0, err
}
func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func CompleteVideoGenerationTask(item model.VideoGenerationTask, media []model.Media) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		var task model.VideoGenerationTask
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&task, "id = ?", item.ID).Error; err != nil {
			return err
		}
		current := time.Now().UTC()
		if task.ClaimID != item.ClaimID || task.Status != "saving" || task.LeaseUntil == nil || !task.LeaseUntil.After(current) {
			return ErrVideoLeaseLost
		}
		ids := make([]string, 0, len(media))
		for _, m := range media {
			if m.ID == "" || m.OwnerUID != task.OwnerUID {
				return errors.New("video task result media owner mismatch")
			}
			if err := tx.Create(&m).Error; err != nil {
				return err
			}
			if err := holdWorkflowGeneratedMedia(tx, task.OwnerUID, task.ClientRequestID, m); err != nil {
				return err
			}
			ids = append(ids, m.ID)
		}
		if err := tx.Model(&task).Updates(map[string]any{"status": "succeeded", "progress": 100, "result_media_ids_json": mustJSON(ids), "finished_at": current, "lease_until": nil, "error": ""}).Error; err != nil {
			return err
		}
		return tx.Model(&model.OperationLog{}).Where("id = ?", task.OperationLogID).Updates(map[string]any{"status": model.OperationStatusSuccess, "provider_task_id": task.ProviderTaskID, "media_ids": mustJSON(ids)}).Error
	})
}

func FinishFailedVideoTask(item model.VideoGenerationTask, message string, current time.Time) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		leaseCheckAt := time.Now().UTC()
		result := tx.Model(&model.VideoGenerationTask{}).Where("id = ? AND claim_id = ? AND lease_until > ?", item.ID, item.ClaimID, leaseCheckAt).Updates(map[string]any{"status": "failed", "error": message, "finished_at": current, "lease_until": nil})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrVideoLeaseLost
		}
		return tx.Model(&model.OperationLog{}).Where("id = ?", item.OperationLogID).Updates(map[string]any{"status": model.OperationStatusFailure, "error_message": message, "provider_task_id": item.ProviderTaskID}).Error
	})
}

// Only select audit-safe columns; provider configuration and temporary URLs never leave persistence.
func ListVideoTasksForOperations(operationIDs []string) ([]model.VideoGenerationTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.VideoGenerationTask, 0)
	if len(operationIDs) == 0 {
		return items, nil
	}
	err = db.Select("id", "operation_log_id", "status", "provider_id", "provider_name", "provider_task_id", "request_json", "amount").Where("operation_log_id IN ?", operationIDs).Find(&items).Error
	return items, err
}
func ListSucceededVideoGenerationTasksFinishedBetween(start, end time.Time) ([]model.VideoGenerationTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.VideoGenerationTask, 0)
	err = db.Select("id", "status", "owner_uid", "provider_id", "provider_name", "request_json", "result_media_ids_json", "amount", "upstream_cost", "upstream_currency").Where("status = ? AND finished_at >= ? AND finished_at < ?", "succeeded", start, end).Find(&items).Error
	return items, err
}
