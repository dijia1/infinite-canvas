package model

import "time"

type OperationStatus string

const (
	OperationStatusSubmitted OperationStatus = "submitted"
	OperationStatusSuccess   OperationStatus = "success"
	OperationStatusFailure   OperationStatus = "failure"
)

// OperationLog records a server-side business action. Image tasks begin as
// submitted and are finalized by the background worker.
type OperationLog struct {
	ID             string          `json:"id" gorm:"primaryKey"`
	ActorUID       string          `json:"actorUid" gorm:"index"`
	ActorName      string          `json:"actorName" gorm:"index"`
	ActorRoles     []string        `json:"actorRoles" gorm:"serializer:json"`
	Action         string          `json:"action" gorm:"index"`
	Status         OperationStatus `json:"status" gorm:"index"`
	TargetType     string          `json:"targetType"`
	TargetID       string          `json:"targetId"`
	TargetName     string          `json:"targetName"`
	Prompt         string          `json:"prompt" gorm:"type:text"`
	MediaIDs       []string        `json:"mediaIds" gorm:"serializer:json"`
	ErrorMessage   string          `json:"errorMessage"`
	RequestSummary string          `json:"requestSummary,omitempty" gorm:"type:text"`
	CreatedAt      time.Time       `json:"createdAt" gorm:"index"`
}

type OperationLogQuery struct {
	Action   string
	Actor    string
	Status   string
	Page     int
	PageSize int
}

func (q *OperationLogQuery) Normalize() {
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

func (q *OperationLogQuery) Offset() int { return (q.Page - 1) * q.PageSize }

type OperationLogList struct {
	Items []OperationLog `json:"items"`
	Total int            `json:"total"`
}
