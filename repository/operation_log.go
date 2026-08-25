package repository

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func SaveOperationLog(item model.OperationLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&item).Error
}

func UpdateOperationLog(id string, updates map[string]any) error {
	if len(updates) == 0 {
		return nil
	}
	if mediaIDs, ok := updates["media_ids"].([]string); ok {
		encoded, err := json.Marshal(mediaIDs)
		if err != nil {
			return err
		}
		copied := make(map[string]any, len(updates))
		for key, value := range updates {
			copied[key] = value
		}
		updates = copied
		updates["media_ids"] = string(encoded)
	}
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.OperationLog{}).Where("id = ?", id).Updates(updates).Error
}

func ListOperationLogs(q model.OperationLogQuery) ([]model.OperationLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.OperationLog{})
	if action := strings.TrimSpace(q.Action); action != "" {
		tx = tx.Where("action = ?", action)
	}
	if status := strings.TrimSpace(q.Status); status != "" {
		tx = tx.Where("status = ?", status)
	}
	if actor := strings.TrimSpace(q.Actor); actor != "" {
		tx = tx.Where("actor_uid LIKE ? OR actor_name LIKE ?", "%"+actor+"%", "%"+actor+"%")
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.OperationLog, 0)
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func DeleteOperationLogsBefore(before time.Time) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("created_at < ?", before).Delete(&model.OperationLog{}).Error
}
