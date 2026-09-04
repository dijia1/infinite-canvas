package model

// MediaUploadIntent represents one short-lived, browser-direct OSS upload.
// It is not a media record until the authenticated owner confirms the object.
type MediaUploadIntent struct {
	ID               string `gorm:"primaryKey"`
	OwnerUID         string `gorm:"index"`
	ObjectKey        string `gorm:"uniqueIndex"`
	Filename         string
	ContentType      string
	ExpectedBytes    int64
	Intent           string
	ExpiresAt        string `gorm:"index"`
	CompletedMediaID string `gorm:"index"`
	CompletedAt      string
	CreatedAt        string `gorm:"index"`
}
