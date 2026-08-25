package model

import "time"

type MediaSource string

const (
	MediaSourceGenerated       MediaSource = "generated"
	MediaSourceUpload          MediaSource = "upload"
	MediaSourceCanvasTemporary MediaSource = "canvas_temporary"
)

// Media is a private image object owned by one Portal user.
type Media struct {
	ID          string      `json:"id" gorm:"primaryKey"`
	OwnerUID    string      `json:"-" gorm:"index"`
	Source      MediaSource `json:"source" gorm:"index;index:idx_media_source_expires"`
	ObjectKey   string      `json:"-" gorm:"uniqueIndex"`
	ContentType string      `json:"contentType"`
	Bytes       int64       `json:"bytes"`
	Width       int         `json:"width"`
	Height      int         `json:"height"`
	Filename    string      `json:"filename"`
	Title       string      `json:"title" gorm:"index"`
	FolderID    string      `json:"folderId" gorm:"index"`
	CreatedAt   string      `json:"createdAt"`
	ExpiresAt   *time.Time  `json:"expiresAt,omitempty" gorm:"index;index:idx_media_source_expires"`
}
