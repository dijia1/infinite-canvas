package repository

import (
	"errors"

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

func PromoteLegacyCanvasTemporaryMedia() (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	result := db.Model(&model.Media{}).
		Where("source = ?", "canvas_temporary").
		Updates(map[string]any{"source": model.MediaSourceUpload, "expires_at": nil})
	return result.RowsAffected, result.Error
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
