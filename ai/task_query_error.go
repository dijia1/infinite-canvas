package ai

import "net/http"

const (
	TaskIssueTransient     = "transient"
	TaskIssueConfiguration = "configuration"
	TaskIssueMissing       = "missing"
	TaskIssueUnknown       = "unknown"
)

// TaskQueryError describes a failed lookup, not a failed generation.
type TaskQueryError struct {
	Kind    string
	Message string
}

func (e *TaskQueryError) Error() string       { return e.Message }
func (e *TaskQueryError) SafeMessage() string { return e.Message }

func NewTaskQueryError(status int, message string) *TaskQueryError {
	kind := TaskIssueTransient
	switch status {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden, http.StatusUnprocessableEntity:
		kind = TaskIssueConfiguration
	case http.StatusNotFound, http.StatusGone:
		kind = TaskIssueMissing
	}
	return &TaskQueryError{Kind: kind, Message: message}
}
