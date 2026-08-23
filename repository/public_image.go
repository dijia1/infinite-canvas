package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SavePublicImage(item model.PublicImage) (model.PublicImage, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, err
	}
	return item, db.Create(&item).Error
}

func GetPublicImage(id string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	item := model.PublicImage{}
	err = db.Preload("Media").First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PublicImage{}, false, nil
	}
	return item, err == nil, err
}

func GetPublicImageByMediaID(mediaID string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	item := model.PublicImage{}
	err = db.First(&item, "media_id = ?", mediaID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PublicImage{}, false, nil
	}
	return item, err == nil, err
}

func ListPublicImages(q model.Query) ([]model.PublicImage, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.PublicImage{})
	if q.FolderID != "" {
		tx = tx.Where("folder_id = ?", q.FolderID)
	} else {
		tx = tx.Where("folder_id = ? OR folder_id IS NULL", "")
	}
	if q.Keyword != "" {
		tx = tx.Where("title LIKE ?", "%"+q.Keyword+"%")
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.PublicImage, 0)
	err = tx.Preload("Media").Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func UpdatePublicImage(id string, title *string, folderID *string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	updates := map[string]any{}
	if title != nil {
		updates["title"] = *title
	}
	if folderID != nil {
		updates["folder_id"] = *folderID
	}
	if err := db.Model(&model.PublicImage{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		return model.PublicImage{}, false, err
	}
	return GetPublicImage(id)
}

func DeletePublicImageAndMedia(publicImageID, mediaID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.PublicImage{}, "id = ?", publicImageID).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Media{}, "id = ?", mediaID).Error
	})
}
