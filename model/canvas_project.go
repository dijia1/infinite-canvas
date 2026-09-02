package model

import (
	"encoding/json"

	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// CanvasProjectDocument keeps the JSON serialization used by all databases
// while requesting a MySQL type that can never narrow an existing LONGTEXT
// column during AutoMigrate.
type CanvasProjectDocument json.RawMessage

func (document CanvasProjectDocument) MarshalJSON() ([]byte, error) {
	return json.RawMessage(document).MarshalJSON()
}

func (document *CanvasProjectDocument) UnmarshalJSON(value []byte) error {
	return (*json.RawMessage)(document).UnmarshalJSON(value)
}

func (CanvasProjectDocument) GormDBDataType(database *gorm.DB, _ *schema.Field) string {
	if database.Dialector.Name() == "mysql" {
		return "LONGTEXT"
	}
	return ""
}

// CanvasProject stores one Portal user's canvas metadata and graph document.
// Media remains in the media library; deleting a project never deletes media.
type CanvasProject struct {
	ID        string                `json:"id" gorm:"primaryKey"`
	OwnerUID  string                `json:"-" gorm:"primaryKey;index"`
	Title     string                `json:"title"`
	Document  CanvasProjectDocument `json:"document" gorm:"serializer:json"`
	Revision  int                   `json:"revision"`
	CreatedAt string                `json:"createdAt" gorm:"index"`
	UpdatedAt string                `json:"updatedAt" gorm:"index"`
}

type CanvasProjectList struct {
	Items []CanvasProject `json:"items"`
	Total int             `json:"total"`
}
