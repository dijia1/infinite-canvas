package model

import "time"

type MediaSource string

type MediaCleanupStatus string

const (
	MediaCleanupActive   MediaCleanupStatus = "active"
	MediaCleanupDeleting MediaCleanupStatus = "deleting"
)

const (
	MediaSourceGenerated MediaSource = "generated"
	MediaSourceUpload    MediaSource = "upload"
)

// Media is a private image object owned by one Portal user.
type Media struct {
	ID                string             `json:"id" gorm:"primaryKey"`
	OwnerUID          string             `json:"-" gorm:"index"`
	Source            MediaSource        `json:"source" gorm:"index;index:idx_media_source_expires"`
	ObjectKey         string             `json:"-" gorm:"uniqueIndex"`
	ObjectVersionID   string             `json:"-"`
	ObjectETag        string             `json:"-" gorm:"column:object_etag"`
	ContentType       string             `json:"contentType"`
	Bytes             int64              `json:"bytes"`
	Duration          float64            `json:"duration"`
	Width             int                `json:"width"`
	Height            int                `json:"height"`
	Filename          string             `json:"filename"`
	Title             string             `json:"title" gorm:"index"`
	FolderID          string             `json:"folderId" gorm:"index"`
	CreatedAt         string             `json:"createdAt"`
	ExpiresAt         *time.Time         `json:"expiresAt,omitempty" gorm:"index;index:idx_media_source_expires"`
	CleanupStatus     MediaCleanupStatus `json:"-" gorm:"not null;default:active;index"`
	CleanupStartedAt  *time.Time         `json:"-"`
	CleanupClaimID    string             `json:"-"`
	CleanupLeaseUntil *time.Time         `json:"-" gorm:"index"`
}
