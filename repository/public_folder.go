package repository

import (
	"errors"
	"gorm.io/gorm/clause"
	"sort"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SavePublicFolder(item model.PublicFolder) (model.PublicFolder, error) {
	db, err := DB()
	if err != nil {
		return model.PublicFolder{}, err
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := lockPublicFolders(tx, item.ParentID); err != nil {
			return err
		}
		return tx.Create(&item).Error
	})
	return item, err
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
	return publicFolderHasContents(db, id)
}
func publicFolderHasContents(db *gorm.DB, id string) (bool, error) {
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
	deleted := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var folder model.PublicFolder
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&folder, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPublicFolderNotFound
			}
			return err
		}
		contains, err := publicFolderHasContents(tx, id)
		if err != nil {
			return err
		}
		if contains {
			return ErrPublicFolderNotEmpty
		}
		result := tx.Delete(&folder)
		deleted = result.RowsAffected > 0
		return result.Error
	})
	return deleted, err
}

var (
	ErrPublicFolderNotFound = errors.New("public folder not found")
	ErrPublicFolderNotEmpty = errors.New("public folder not empty")
)

// Writers and deletion lock the same directory row. Sort before locking more
// than one directory so opposite moves cannot acquire them in reverse order.
func lockPublicFolders(tx *gorm.DB, ids ...string) error {
	sort.Strings(ids)
	previous := ""
	for _, id := range ids {
		if id == "" || id == previous {
			continue
		}
		previous = id
		var folder model.PublicFolder
		if err := tx.Clauses(clause.Locking{Strength: "KEY SHARE"}).Select("id").First(&folder, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPublicFolderNotFound
			}
			return err
		}
	}
	return nil
}
