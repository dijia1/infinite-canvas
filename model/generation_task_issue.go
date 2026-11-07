package model

import "time"

// GenerationTaskIssue is shared by canvas tasks and workflow output views.
type GenerationTaskIssue struct {
	Kind                string     `json:"kind"`
	Stage               string     `json:"stage"`
	ConsecutiveFailures int        `json:"consecutiveFailures"`
	NextRetryAt         *time.Time `json:"nextRetryAt,omitempty"`
}
