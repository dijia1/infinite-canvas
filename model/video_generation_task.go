package model

import (
	"github.com/shopspring/decimal"
	"time"
)

// VideoGenerationTask owns durable input references until it reaches a terminal state.
type VideoGenerationTask struct {
	ID                 string          `json:"id" gorm:"primaryKey"`
	OwnerUID           string          `json:"-" gorm:"uniqueIndex:idx_video_owner_client"`
	ClientRequestID    string          `json:"clientRequestId" gorm:"uniqueIndex:idx_video_owner_client"`
	RequestHash        string          `json:"-" gorm:"size:64"`
	Status             string          `json:"status" gorm:"index"`
	ProviderID         string          `json:"-"`
	ProviderName       string          `json:"-"`
	ProviderType       string          `json:"-"`
	ProviderConfig     string          `json:"-"`
	ProviderTaskID     string          `json:"-"`
	RequestJSON        string          `json:"-" gorm:"type:text"`
	InputMediaIDsJSON  string          `json:"-" gorm:"type:text"`
	ResultMediaIDsJSON string          `json:"-" gorm:"type:text"`
	PendingOutputsJSON string          `json:"-" gorm:"type:text"`
	ResultURLsJSON     string          `json:"-" gorm:"type:text"`
	Amount             decimal.Decimal `json:"-" gorm:"type:decimal(12,4)"`
	UpstreamCost       string          `json:"-"`
	UpstreamCurrency   string          `json:"-"`
	Progress           int             `json:"progress"`
	Error              string          `json:"error,omitempty"`
	OperationLogID     string          `json:"-" gorm:"index"`
	ClaimID            string          `json:"-"`
	LeaseUntil         *time.Time      `json:"-" gorm:"index"`
	NextPollAt         time.Time       `json:"-" gorm:"index"`
	Deadline           time.Time       `json:"-"`
	Attempts           int             `json:"-"`
	CreatedAt          time.Time       `json:"createdAt"`
	UpdatedAt          time.Time       `json:"-"`
	FinishedAt         *time.Time      `json:"-"`
}
