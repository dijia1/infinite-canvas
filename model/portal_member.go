package model

import "time"

// PortalMember is the application's local, synchronized view of a Portal user.
type PortalMember struct {
	UserUID     string    `json:"userUid" gorm:"primaryKey"`
	DisplayName string    `json:"displayName"`
	Enabled     bool      `json:"enabled" gorm:"index"`
	Roles       []string  `json:"roles" gorm:"serializer:json"`
	Departments []string  `json:"departments" gorm:"serializer:json"`
	SyncedAt    time.Time `json:"syncedAt"`
}

type PortalMemberQuery struct {
	Query    string
	Page     int
	PageSize int
}

func (q *PortalMemberQuery) Normalize() {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize < 1 {
		q.PageSize = 20
	}
	if q.PageSize > MaxPageSize {
		q.PageSize = MaxPageSize
	}
}

func (q *PortalMemberQuery) Offset() int { return (q.Page - 1) * q.PageSize }

type PortalMemberList struct {
	Items []PortalMember `json:"items"`
	Total int            `json:"total"`
}
