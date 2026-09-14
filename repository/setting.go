package repository

import (
	"encoding/json"
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SettingsRevisionConflictError means the full settings document was saved
// from an obsolete revision. It intentionally carries no settings content.
type SettingsRevisionConflictError struct {
	CurrentRevision int
}

func (err *SettingsRevisionConflictError) Error() string { return "settings revision conflict" }

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
			result.Revision = item.Revision
		}
	}
	return result, nil
}

// SaveSettings 保存 AI 配置。
func SaveSettings(settings model.Settings, now string) (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return model.Settings{}, err
	}
	value, _ := json.Marshal(settings.AI)
	err = db.Transaction(func(transaction *gorm.DB) error {
		if settings.Revision == 0 {
			item := model.Setting{Key: model.SettingKeyAI, Value: value, Revision: 1, CreatedAt: now, UpdatedAt: now}
			created := transaction.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoNothing: true}).Create(&item)
			if created.Error != nil {
				return created.Error
			}
			if created.RowsAffected == 1 {
				settings.Revision = 1
				return nil
			}
		} else if settings.Revision > 0 {
			updated := transaction.Model(&model.Setting{}).
				Where("key = ? AND revision = ?", model.SettingKeyAI, settings.Revision).
				Updates(map[string]any{
					"value":      gorm.Expr("?::jsonb", string(value)),
					"revision":   gorm.Expr("revision + 1"),
					"updated_at": now,
				})
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected == 1 {
				settings.Revision++
				return nil
			}
		}

		var current model.Setting
		lookup := transaction.Select("revision").Where("key = ?", model.SettingKeyAI).Take(&current)
		if lookup.Error != nil && !errors.Is(lookup.Error, gorm.ErrRecordNotFound) {
			return lookup.Error
		}
		return &SettingsRevisionConflictError{CurrentRevision: current.Revision}
	})
	if err != nil {
		return model.Settings{}, err
	}
	return settings, nil
}
