package repository

import (
	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
)

// Match task creation's media-before-task lock order. Inputs are immutable once created.
func lockPreparingSourceMasks(tx *gorm.DB, taskID string) ([]model.Media, error) {
	var ids []string
	if err := tx.Model(&model.ImageGenerationTaskInput{}).Where("task_id = ?", taskID).Distinct("source_media_id").Pluck("source_media_id", &ids).Error; err != nil {
		return nil, err
	}
	var masks []model.Media
	if len(ids) == 0 {
		return masks, nil
	}
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id IN ? AND source = ?", ids, model.MediaSourceMask).Order("id").Find(&masks).Error
	return masks, err
}

func scheduleReleasedMasks(tx *gorm.DB, masks []model.Media, timestamp string) error {
	current, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return err
	}
	for _, item := range masks {
		held, err := imageTaskPreparingMediaReferenced(tx, item.ID)
		if err != nil {
			return err
		}
		if held {
			continue
		}
		expiry := current.Add(canvasMediaCleanupDelay)
		if err := tx.Model(&model.Media{}).Where("id = ? AND cleanup_status = ?", item.ID, model.MediaCleanupActive).Update("expires_at", expiry).Error; err != nil {
			return err
		}
		item.ExpiresAt = &expiry
		if err := recordMediaLifecycle(tx, item, "", "cleanup_scheduled", "", "mask_preparation_finished"); err != nil {
			return err
		}
	}
	return nil
}
