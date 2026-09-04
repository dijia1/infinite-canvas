package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveMediaUploadIntent(item model.MediaUploadIntent) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Create(&item).Error
}

func GetMediaUploadIntentForOwner(id, ownerUID string) (model.MediaUploadIntent, bool, error) {
	database, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, false, err
	}
	item := model.MediaUploadIntent{}
	err = database.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.MediaUploadIntent{}, false, nil
	}
	return item, err == nil, err
}

// FinalizeMediaUploadIntent claims an intent and creates its media record in
// the same transaction. A retry returns the media created by the first call.
func FinalizeMediaUploadIntent(id, ownerUID, completedAt string, media model.Media) (model.MediaUploadIntent, model.Media, bool, error) {
	database, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, model.Media{}, false, err
	}
	intent := model.MediaUploadIntent{}
	resultMedia := model.Media{}
	created := false
	err = database.Transaction(func(transaction *gorm.DB) error {
		result := transaction.Model(&model.MediaUploadIntent{}).
			Where("id = ? AND owner_uid = ? AND completed_media_id = '' AND expires_at > ?", id, ownerUID, completedAt).
			Updates(map[string]any{"completed_media_id": media.ID, "completed_at": completedAt})
		if result.Error != nil {
			return result.Error
		}
		if err := transaction.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&intent).Error; err != nil {
			return err
		}
		if result.RowsAffected == 0 {
			if intent.CompletedMediaID == "" {
				return nil
			}
			if err := transaction.First(&resultMedia, "id = ?", intent.CompletedMediaID).Error; err != nil {
				return err
			}
			return nil
		}
		if err := transaction.Create(&media).Error; err != nil {
			return err
		}
		resultMedia = media
		created = true
		return nil
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.MediaUploadIntent{}, model.Media{}, false, nil
	}
	return intent, resultMedia, created, err
}

func ListExpiredUncompletedMediaUploadIntents(before string) ([]model.MediaUploadIntent, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.MediaUploadIntent, 0)
	err = database.Where("expires_at < ? AND completed_media_id = ''", before).Order("expires_at asc").Find(&items).Error
	return items, err
}

func DeleteMediaUploadIntent(id string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Delete(&model.MediaUploadIntent{}, "id = ?", id).Error
}

func DeleteCompletedMediaUploadIntentsBefore(before string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Where("completed_media_id <> '' AND completed_at < ?", before).Delete(&model.MediaUploadIntent{}).Error
}
