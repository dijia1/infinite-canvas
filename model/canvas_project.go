package model

import "encoding/json"

// CanvasProject stores one Portal user's canvas metadata and graph document.
// Media remains in the media library; deleting a project never deletes media.
type CanvasProject struct {
	ID        string          `json:"id" gorm:"primaryKey"`
	OwnerUID  string          `json:"-" gorm:"index"`
	Title     string          `json:"title"`
	Document  json.RawMessage `json:"document" gorm:"type:text"`
	Revision  int             `json:"revision"`
	CreatedAt string          `json:"createdAt" gorm:"index"`
	UpdatedAt string          `json:"updatedAt" gorm:"index"`
}

type CanvasProjectList struct {
	Items []CanvasProject `json:"items"`
	Total int             `json:"total"`
}
