package repository

import (
	"errors"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveMedia(item model.Media) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, err
	}
	return item, db.Create(&item).Error
}

func GetMedia(id string) (model.Media, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, false, err
	}
	item := model.Media{}
	err = db.First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Media{}, false, nil
	}
	return item, err == nil, err
}

func DeleteMedia(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.Media{}, "id = ?", id).Error
}

func ListPrivateMedia(ownerUID string) ([]model.Media, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.Media, 0)
	err = db.Where("owner_uid = ?", ownerUID).
		Where("NOT EXISTS (SELECT 1 FROM public_images WHERE public_images.media_id = media.id)").
		Order("created_at desc").
		Find(&items).Error
	return items, err
}

func ListExpiredTemporaryMedia(before time.Time) ([]model.Media, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.Media, 0)
	err = db.Where("source = ?", model.MediaSourceCanvasTemporary).
		Where("expires_at IS NOT NULL AND expires_at <= ?", before).
		Order("expires_at asc").
		Find(&items).Error
	return items, err
}

func UpdatePrivateMedia(id, ownerUID string, title *string, folderID *string) (model.Media, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, false, err
	}
	updates := map[string]any{}
	if title != nil {
		updates["title"] = *title
	}
	if folderID != nil {
		updates["folder_id"] = *folderID
	}
	if len(updates) == 0 {
		return model.Media{}, false, nil
	}
	result := db.Model(&model.Media{}).Where("id = ? AND owner_uid = ?", id, ownerUID).Updates(updates)
	if result.Error != nil || result.RowsAffected == 0 {
		return model.Media{}, false, result.Error
	}
	return GetMedia(id)
}

func PreserveTemporaryMedia(id, ownerUID string) (model.Media, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, false, err
	}
	result := db.Model(&model.Media{}).
		Where("id = ? AND owner_uid = ? AND source = ?", id, ownerUID, model.MediaSourceCanvasTemporary).
		Updates(map[string]any{"source": model.MediaSourceUpload, "expires_at": nil})
	if result.Error != nil || result.RowsAffected == 0 {
		return model.Media{}, false, result.Error
	}
	return GetMedia(id)
}
