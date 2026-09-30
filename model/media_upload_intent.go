package model

import "time"

// MediaUploadIntent represents one short-lived, browser-direct OSS upload.
// It is not a media record until the authenticated owner confirms the object.
type MediaUploadIntent struct {
	ID                 string `gorm:"primaryKey"`
	OwnerUID           string `gorm:"index"`
	ObjectKey          string `gorm:"uniqueIndex"`
	Filename           string
	ContentType        string
	ExpectedBytes      int64
	Intent             string
	ExpiresAt          string `gorm:"index"`
	FinalObjectKey     string
	FinalizeClaimID    string
	FinalizeLeaseUntil *time.Time
	CompletedMediaID   string `gorm:"index"`
	CompletedAt        string
	CreatedAt          string `gorm:"index"`
	// Server-side public imports use the same reservation/cleanup protocol. These
	// optional fields are empty for existing browser uploads.
	SourcePublicImageID string
	SourceMediaID       string `gorm:"index"`
	SourceObjectKey     string
	SourceVersionID     string
	SourceETag          string
	CopyStartedAt       *time.Time
}
