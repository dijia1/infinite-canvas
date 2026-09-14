package model

import "time"

type WorkflowRunScopeType string

const (
	WorkflowRunScopeWorkflow WorkflowRunScopeType = "workflow"
	WorkflowRunScopeFrame    WorkflowRunScopeType = "frame"
)

type WorkflowRunScope struct {
	Type    WorkflowRunScopeType `json:"type"`
	FrameID string               `json:"frameId,omitempty"`
}

// Run snapshots never reference the mutable definition through a cascading FK.
type WorkflowRun struct {
	ID            string               `json:"id" gorm:"primaryKey;size:128"`
	OwnerUID      string               `json:"-" gorm:"index;uniqueIndex:idx_workflow_run_request"`
	RequestID     string               `json:"requestId" gorm:"size:128;uniqueIndex:idx_workflow_run_request"`
	WorkflowID    string               `json:"workflowId" gorm:"index"`
	Revision      int                  `json:"revision"`
	Title         string               `json:"title"`
	ScopeType     WorkflowRunScopeType `json:"scopeType" gorm:"size:16;not null;default:workflow"`
	FrameID       string               `json:"frameId" gorm:"size:128;not null;default:''"`
	FrameName     string               `json:"frameName" gorm:"size:128;not null;default:''"`
	Snapshot      string               `json:"-" gorm:"type:text"`
	Status        string               `json:"status" gorm:"index"`
	StateVersion  int64                `json:"-" gorm:"not null;default:1"`
	StopRequested bool                 `json:"stopRequested"`
	CreatedAt     time.Time            `json:"createdAt" gorm:"index"`
	UpdatedAt     time.Time            `json:"updatedAt"`
	FinishedAt    *time.Time           `json:"finishedAt,omitempty"`
}

type WorkflowStepExecution struct {
	RunID  string `json:"runId" gorm:"primaryKey;size:128"`
	NodeID string `json:"nodeId" gorm:"primaryKey;size:128"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type WorkflowOutputExecution struct {
	RunID          string    `json:"runId" gorm:"primaryKey;size:128"`
	NodeID         string    `json:"nodeId" gorm:"primaryKey;size:128"`
	SlotID         string    `json:"slotId" gorm:"primaryKey;size:128"`
	Status         string    `json:"status" gorm:"index"`
	Attempt        int       `json:"attempt"`
	MediaID        string    `json:"mediaId,omitempty"`
	Error          string    `json:"error,omitempty"`
	RetryRequestID string    `json:"-" gorm:"size:128"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type WorkflowOutputAttempt struct {
	ID             string     `json:"id" gorm:"primaryKey;size:128"`
	RunID          string     `json:"runId" gorm:"uniqueIndex:idx_workflow_attempt_slot;index;index:idx_workflow_attempt_retry"`
	NodeID         string     `json:"nodeId" gorm:"uniqueIndex:idx_workflow_attempt_slot;index:idx_workflow_attempt_retry"`
	SlotID         string     `json:"slotId" gorm:"uniqueIndex:idx_workflow_attempt_slot;index:idx_workflow_attempt_retry"`
	Attempt        int        `json:"attempt" gorm:"uniqueIndex:idx_workflow_attempt_slot"`
	OwnerUID       string     `json:"-" gorm:"uniqueIndex:idx_workflow_attempt_request"`
	RequestID      string     `json:"requestId" gorm:"size:128;uniqueIndex:idx_workflow_attempt_request"`
	RetryRequestID string     `json:"-" gorm:"size:128;index:idx_workflow_attempt_retry"`
	TaskType       string     `json:"taskType"`
	TaskID         string     `json:"taskId,omitempty" gorm:"index"`
	ResumeTaskID   string     `json:"resumeTaskId,omitempty" gorm:"-"`
	Status         string     `json:"status" gorm:"index"`
	Error          string     `json:"error,omitempty"`
	MediaID        string     `json:"mediaId,omitempty"`
	ClaimID        string     `json:"-"`
	LeaseUntil     *time.Time `json:"-" gorm:"index"`
	NextPollAt     time.Time  `json:"-" gorm:"index"`
	QueuedAt       *time.Time `json:"queuedAt,omitempty"`
	StartedAt      *time.Time `json:"startedAt,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	FinishedAt     *time.Time `json:"finishedAt,omitempty"`
}
