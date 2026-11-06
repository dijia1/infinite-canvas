package repository

import "gorm.io/gorm"

// Terminal replay uses the saved request schema, hash and result media. Provider
// credentials are only needed while a task can still be polled or resumed.
func clearTerminalGenerationTaskConfigs(db *gorm.DB) error {
	for _, table := range []string{"image_generation_tasks", "video_generation_tasks"} {
		if err := db.Table(table).Where("status IN ? AND provider_config <> ''", []string{"succeeded", "failed"}).Update("provider_config", "").Error; err != nil {
			return err
		}
	}
	return nil
}
