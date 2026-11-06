package service

import (
	"errors"
	"fmt"
	"testing"
)

func TestWrappedBusinessErrorsPreserveUserAndAuditMessages(t *testing.T) {
	err := fmt.Errorf("store private details: %w", safeMessageError{message: "参考图片不存在"})
	if message := imageTaskFailureMessage(err); message != "参考图片不存在" {
		t.Fatalf("task failure message=%q", message)
	}
	if message := AuditErrorSummary(err, "操作失败"); message != "参考图片不存在" {
		t.Fatalf("audit message=%q", message)
	}
	validation := workflowRunValidationError(err, "操作失败")
	if message, ok := SafeMessage(validation); !ok || message != "参考图片不存在" {
		t.Fatalf("workflow validation=%v", validation)
	}
	if message := AuditErrorSummary(errors.New("internal private details"), "操作失败"); message != "操作失败" {
		t.Fatalf("unsafe audit message=%q", message)
	}
}
