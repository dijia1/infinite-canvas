package model

import (
	"time"

	"github.com/shopspring/decimal"
)

type ImageGenerationTaskStatus string

const (
	ImageTaskQueued     ImageGenerationTaskStatus = "queued"
	ImageTaskSubmitting ImageGenerationTaskStatus = "submitting"
	ImageTaskRunning    ImageGenerationTaskStatus = "running"
	ImageTaskSucceeded  ImageGenerationTaskStatus = "succeeded"
	ImageTaskFailed     ImageGenerationTaskStatus = "failed"
	ImageTaskUncertain  ImageGenerationTaskStatus = "uncertain"
)

type ImageGenerationTask struct {
	ID                  string                    `json:"id" gorm:"primaryKey"`
	OwnerUID            string                    `json:"-" gorm:"uniqueIndex:idx_image_task_owner_client;index"`
	ClientRequestID     string                    `json:"clientRequestId" gorm:"uniqueIndex:idx_image_task_owner_client"`
	RequestHash         string                    `json:"-" gorm:"size:64"`
	RequestHashVersion  int                       `json:"-"`
	RequestSchemaJSON   string                    `json:"-" gorm:"type:text"`
	Mode                string                    `json:"mode"`
	Status              ImageGenerationTaskStatus `json:"status" gorm:"index"`
	ProviderID          string                    `json:"-"`
	ProviderName        string                    `json:"-" gorm:"index"`
	ProviderType        string                    `json:"-"`
	ProviderConfig      string                    `json:"-"`
	Prompt              string                    `json:"prompt"`
	Quality             string                    `json:"quality"`
	Size                string                    `json:"size"`
	Resolution          string                    `json:"resolution"`
	OutputFormat        string                    `json:"outputFormat"`
	Background          string                    `json:"background"`
	ProviderOptionsJSON string                    `json:"-" gorm:"type:text"`
	Count               int                       `json:"count"`
	Amount              decimal.Decimal           `json:"-" gorm:"type:decimal(12,4);not null;default:0"`
	AmountRecorded      bool                      `json:"-" gorm:"not null;default:false"`
	ReferencesJSON      string                    `json:"-"`
	RequestSummary      string                    `json:"-" gorm:"type:text"`
	OperationLogID      string                    `json:"-" gorm:"index"`
	ProviderTaskID      string                    `json:"-" gorm:"index"`
	ClaimID             string                    `json:"-" gorm:"index"`
	LeaseUntil          *time.Time                `json:"-" gorm:"index"`
	Progress            int                       `json:"progress"`
	ResultMediaIDsJSON  string                    `json:"-"`
	ErrorMessage        string                    `json:"error,omitempty"`
	CreatedAt           string                    `json:"createdAt" gorm:"index"`
	UpdatedAt           string                    `json:"updatedAt" gorm:"index"`
	FinishedAt          string                    `json:"finishedAt,omitempty" gorm:"index"`
}
