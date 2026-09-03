package repository

import "strings"

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
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "enabled", "roles", "departments", "synced_at"}),
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
				DoUpdates: clause.AssignmentColumns([]string{"display_name", "enabled", "roles", "departments", "synced_at"}),
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

func ListPortalMembers(q model.PortalMemberQuery) ([]model.PortalMember, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.PortalMember{})
	if query := strings.TrimSpace(q.Query); query != "" {
		like := "%" + query + "%"
		tx = tx.Where("user_uid LIKE ? OR display_name LIKE ?", like, like)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.PortalMember, 0)
	err = tx.Order("enabled desc, display_name asc, user_uid asc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func ListCanvasShareRecipients(senderUID string, q model.PortalMemberQuery) ([]model.PortalMember, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.PortalMember{}).Where("enabled = ? AND user_uid <> ?", true, senderUID)
	if query := strings.TrimSpace(q.Query); query != "" {
		like := "%" + query + "%"
		tx = tx.Where("user_uid LIKE ? OR display_name LIKE ?", like, like)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.PortalMember, 0)
	err = tx.Order("display_name asc, user_uid asc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}
