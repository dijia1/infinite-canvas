package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SavePrivateFolder(item model.PrivateFolder) (model.PrivateFolder, error) {
	db, err := DB()
	if err != nil {
		return model.PrivateFolder{}, err
	}
	return item, db.Create(&item).Error
}

func GetPrivateFolder(ownerUID, id string) (model.PrivateFolder, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PrivateFolder{}, false, err
	}
	item := model.PrivateFolder{}
	err = db.First(&item, "id = ? AND owner_uid = ?", id, ownerUID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PrivateFolder{}, false, nil
	}
	return item, err == nil, err
}

func ListPrivateFolders(ownerUID string) ([]model.PrivateFolder, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.PrivateFolder, 0)
	err = db.Where("owner_uid = ?", ownerUID).Order("created_at asc").Find(&items).Error
	return items, err
}

func UpdatePrivateFolderTitle(ownerUID, id, title string) (model.PrivateFolder, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PrivateFolder{}, false, err
	}
	result := db.Model(&model.PrivateFolder{}).Where("id = ? AND owner_uid = ?", id, ownerUID).Update("title", title)
	if result.Error != nil || result.RowsAffected == 0 {
		return model.PrivateFolder{}, false, result.Error
	}
	return GetPrivateFolder(ownerUID, id)
}

func PrivateFolderHasContents(ownerUID, id string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	if err := db.Model(&model.PrivateFolder{}).Where("owner_uid = ? AND parent_id = ?", ownerUID, id).Count(&count).Error; err != nil {
		return false, err
	}
	if count > 0 {
		return true, nil
	}
	if err := db.Model(&model.Media{}).Where("owner_uid = ? AND folder_id = ?", ownerUID, id).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func DeletePrivateFolder(ownerUID, id string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Delete(&model.PrivateFolder{}, "id = ? AND owner_uid = ?", id, ownerUID)
	return result.RowsAffected > 0, result.Error
}
