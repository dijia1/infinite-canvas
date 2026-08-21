package repository

import (
	"encoding/json"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm/clause"
)

// GetSettings 返回 AI 配置。
func GetSettings() (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return model.Settings{}, err
	}
	var items []model.Setting
	if err := db.Find(&items).Error; err != nil {
		return model.Settings{}, err
	}
	result := model.Settings{}
	for _, item := range items {
		if item.Key == model.SettingKeyAI {
			_ = json.Unmarshal(item.Value, &result.AI)
		}
	}
	return result, nil
}

// SaveSettings 保存 AI 配置。
func SaveSettings(settings model.Settings, now string) (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return settings, err
	}
	value, _ := json.Marshal(settings.AI)
	items := []model.Setting{
		{Key: model.SettingKeyAI, Value: value, CreatedAt: now, UpdatedAt: now},
	}
	err = db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&items).Error
	return settings, err
}
