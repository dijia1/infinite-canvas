package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func CreateCanvasProject(item model.CanvasProject) (model.CanvasProject, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	result := database.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}, {Name: "owner_uid"}}, DoNothing: true}).Create(&item)
	if result.Error != nil {
		return model.CanvasProject{}, false, result.Error
	}
	if result.RowsAffected > 0 {
		return item, true, nil
	}
	existing, found, err := GetCanvasProject(item.OwnerUID, item.ID)
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	if !found {
		return model.CanvasProject{}, false, errors.New("canvas project was not found after insert conflict")
	}
	return existing, false, nil
}

// ImportCanvasProjects inserts a complete legacy batch atomically. Existing
// projects belonging to the same owner are returned unchanged, making retries
// safe without allowing imports to overwrite newer server snapshots.
func ImportCanvasProjects(items []model.CanvasProject) ([]model.CanvasProject, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	resultItems := make([]model.CanvasProject, 0, len(items))
	err = database.Transaction(func(transaction *gorm.DB) error {
		for _, item := range items {
			result := transaction.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}, {Name: "owner_uid"}}, DoNothing: true}).Create(&item)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected > 0 {
				resultItems = append(resultItems, item)
				continue
			}
			existing := model.CanvasProject{}
			if err := transaction.Where("id = ? AND owner_uid = ?", item.ID, item.OwnerUID).First(&existing).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return errors.New("canvas project was not found after import conflict")
				}
				return err
			}
			resultItems = append(resultItems, existing)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return resultItems, nil
}

func GetCanvasProject(ownerUID, id string) (model.CanvasProject, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	item := model.CanvasProject{}
	err = database.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.CanvasProject{}, false, nil
	}
	return item, err == nil, err
}

func ListCanvasProjects(ownerUID string) ([]model.CanvasProject, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.CanvasProject, 0)
	err = database.Where("owner_uid = ?", ownerUID).Order("updated_at desc").Find(&items).Error
	return items, err
}

func UpdateCanvasProject(ownerUID, id string, revision int, title string, document []byte, updatedAt string) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	result := database.Model(&model.CanvasProject{}).
		Where("id = ? AND owner_uid = ? AND revision = ?", id, ownerUID, revision).
		Updates(map[string]any{
			"title":      title,
			"document":   document,
			"revision":   gorm.Expr("revision + ?", 1),
			"updated_at": updatedAt,
		})
	return result.RowsAffected > 0, result.Error
}

func DeleteCanvasProject(ownerUID, id string, revision int) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	result := database.Where("id = ? AND owner_uid = ? AND revision = ?", id, ownerUID, revision).Delete(&model.CanvasProject{})
	return result.RowsAffected > 0, result.Error
}
