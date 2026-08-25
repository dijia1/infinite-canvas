package service

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const auditRetention = 7 * 24 * time.Hour

type OperationLogInput struct {
	Action         string
	Status         model.OperationStatus
	TargetType     string
	TargetID       string
	TargetName     string
	Prompt         string
	MediaIDs       []string
	ErrorMessage   string
	RequestSummary string
}

func AuditErrorSummary(err error, fallback string) string {
	if err == nil {
		return ""
	}
	if safe, ok := err.(interface{ SafeMessage() string }); ok {
		return safeAuditError(safe.SafeMessage())
	}
	return fallback
}

func RecordOperation(ctx context.Context, input OperationLogInput) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || strings.TrimSpace(input.Action) == "" {
		return
	}
	if input.Status == "" {
		input.Status = model.OperationStatusSuccess
	}
	if err := repository.SaveOperationLog(model.OperationLog{
		ID: newID("operation"), ActorUID: user.UID, ActorName: PortalDisplayName(user), ActorRoles: append([]string{}, user.Roles...),
		Action: input.Action, Status: input.Status, TargetType: input.TargetType, TargetID: input.TargetID, TargetName: input.TargetName,
		Prompt: input.Prompt, MediaIDs: append([]string{}, input.MediaIDs...), ErrorMessage: safeAuditError(input.ErrorMessage), RequestSummary: strings.TrimSpace(input.RequestSummary), CreatedAt: time.Now().UTC(),
	}); err != nil {
		log.Printf("operation audit write failed: action=%s actor=%s error=%v", input.Action, user.UID, err)
	}
}

func safeAuditError(message string) string {
	message = strings.TrimSpace(message)
	if len(message) > 500 {
		return message[:500]
	}
	return message
}

func ListOperationLogs(query model.OperationLogQuery) (model.OperationLogList, error) {
	items, total, err := repository.ListOperationLogs(query)
	if err != nil {
		return model.OperationLogList{}, err
	}
	for index := range items {
		if items[index].ActorRoles == nil {
			items[index].ActorRoles = []string{}
		}
		if items[index].MediaIDs == nil {
			items[index].MediaIDs = []string{}
		}
	}
	return model.OperationLogList{Items: items, Total: int(total)}, nil
}

func CleanupExpiredOperationLogs(now time.Time) error {
	return repository.DeleteOperationLogsBefore(now.UTC().Add(-auditRetention))
}

func StartOperationLogRetention(ctx context.Context) func() {
	if err := CleanupExpiredOperationLogs(time.Now()); err != nil {
		log.Printf("operation audit cleanup failed: %v", err)
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case current := <-ticker.C:
				if err := CleanupExpiredOperationLogs(current); err != nil {
					log.Printf("operation audit cleanup failed: %v", err)
				}
			}
		}
	}()
	return func() { close(stop) }
}
