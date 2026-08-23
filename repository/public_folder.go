package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SavePublicFolder(item model.PublicFolder) (model.PublicFolder, error) {
	db, err := DB()
	if err != nil {
		return model.PublicFolder{}, err
	}
	return item, db.Create(&item).Error
}

func GetPublicFolder(id string) (model.PublicFolder, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicFolder{}, false, err
	}
	item := model.PublicFolder{}
	err = db.First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PublicFolder{}, false, nil
	}
	return item, err == nil, err
}

func ListPublicFolders() ([]model.PublicFolder, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.PublicFolder, 0)
	err = db.Order("created_at asc").Find(&items).Error
	return items, err
}

func UpdatePublicFolderTitle(id, title string) (model.PublicFolder, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicFolder{}, false, err
	}
	result := db.Model(&model.PublicFolder{}).Where("id = ?", id).Update("title", title)
	if result.Error != nil {
		return model.PublicFolder{}, false, result.Error
	}
	if result.RowsAffected == 0 {
		return model.PublicFolder{}, false, nil
	}
	return GetPublicFolder(id)
}

func PublicFolderHasContents(id string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	if err := db.Model(&model.PublicFolder{}).Where("parent_id = ?", id).Count(&count).Error; err != nil {
		return false, err
	}
	if count > 0 {
		return true, nil
	}
	if err := db.Model(&model.PublicImage{}).Where("folder_id = ?", id).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func DeletePublicFolder(id string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Delete(&model.PublicFolder{}, "id = ?", id)
	return result.RowsAffected > 0, result.Error
}
