package model

import (
	"github.com/shopspring/decimal"
	"time"
)

type OperationStatus string

const (
	OperationStatusSubmitted OperationStatus = "submitted"
	OperationStatusSuccess   OperationStatus = "success"
	OperationStatusFailure   OperationStatus = "failure"
)

// OperationLog records a server-side business action. Image tasks begin as
// submitted and are finalized by the background worker.
type VideoOperationDetails struct {
	TaskID         string          `json:"taskId"`
	Status         string          `json:"status"`
	ProviderID     string          `json:"providerId"`
	ProviderName   string          `json:"providerName"`
	ProviderTaskID string          `json:"providerTaskId"`
	Seconds        int             `json:"seconds"`
	Size           string          `json:"size"`
	Resolution     string          `json:"resolution"`
	GenerateAudio  bool            `json:"generateAudio"`
	Amount         decimal.Decimal `json:"amount"`
}

type ImageOperationDetails struct {
	TaskID         string          `json:"taskId"`
	Status         string          `json:"status"`
	ProviderID     string          `json:"providerId"`
	ProviderName   string          `json:"providerName"`
	ProviderTaskID string          `json:"providerTaskId"`
	Quality        string          `json:"quality"`
	Size           string          `json:"size"`
	Resolution     string          `json:"resolution"`
	OutputFormat   string          `json:"outputFormat"`
	Background     string          `json:"background"`
	Amount         decimal.Decimal `json:"amount"`
}

type OperationLog struct {
	Image          *ImageOperationDetails `json:"image,omitempty" gorm:"-"`
	Video          *VideoOperationDetails `json:"video,omitempty" gorm:"-"`
	ID             string                 `json:"id" gorm:"primaryKey"`
	ActorUID       string                 `json:"actorUid" gorm:"index"`
	ActorName      string                 `json:"actorName" gorm:"index"`
	ActorRoles     []string               `json:"actorRoles" gorm:"serializer:json"`
	Action         string                 `json:"action" gorm:"index"`
	Status         OperationStatus        `json:"status" gorm:"index"`
	TargetType     string                 `json:"targetType"`
	TargetID       string                 `json:"targetId" gorm:"index"`
	ProviderTaskID string                 `json:"providerTaskId,omitempty" gorm:"index"`
	TargetName     string                 `json:"targetName"`
	Prompt         string                 `json:"prompt" gorm:"type:text"`
	MediaIDs       []string               `json:"mediaIds" gorm:"serializer:json"`
	ErrorMessage   string                 `json:"errorMessage"`
	RequestSummary string                 `json:"requestSummary,omitempty" gorm:"type:text"`
	CreatedAt      time.Time              `json:"createdAt" gorm:"index"`
}

type OperationLogQuery struct {
	MediaID  string
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
