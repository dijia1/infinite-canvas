package model

import "time"

// PortalMember is the application's local, synchronized view of a Portal user.
type PortalMember struct {
	UserUID     string    `json:"userUid" gorm:"primaryKey"`
	DisplayName string    `json:"displayName"`
	Enabled     bool      `json:"enabled" gorm:"index"`
	Roles       []string  `json:"roles" gorm:"serializer:json"`
	SyncedAt    time.Time `json:"syncedAt"`
}
