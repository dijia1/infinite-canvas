package repository

import (
	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func UpsertPortalMembers(items []model.PortalMember) error {
	if len(items) == 0 {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_uid"}},
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "enabled", "roles", "synced_at"}),
	}).Create(&items).Error
}

func SyncPortalMembers(items []model.PortalMember) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if len(items) > 0 {
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "user_uid"}},
				DoUpdates: clause.AssignmentColumns([]string{"display_name", "enabled", "roles", "synced_at"}),
			}).Create(&items).Error; err != nil {
				return err
			}
		}
		userUIDs := make([]string, 0, len(items))
		for _, item := range items {
			userUIDs = append(userUIDs, item.UserUID)
		}
		updates := map[string]any{"enabled": false}
		if len(userUIDs) == 0 {
			return tx.Model(&model.PortalMember{}).Where("enabled = ?", true).Updates(updates).Error
		}
		return tx.Model(&model.PortalMember{}).Where("enabled = ? AND user_uid NOT IN ?", true, userUIDs).Updates(updates).Error
	})
}

func GetPortalMember(userUID string) (model.PortalMember, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PortalMember{}, false, err
	}
	item := model.PortalMember{}
	result := db.Where("user_uid = ?", userUID).Limit(1).Find(&item)
	if result.Error != nil {
		return model.PortalMember{}, false, result.Error
	}
	return item, result.RowsAffected > 0, nil
}
