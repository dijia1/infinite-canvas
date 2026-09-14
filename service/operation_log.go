package service

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

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
	operationIDs := make([]string, 0, len(items))
	for _, item := range items {
		operationIDs = append(operationIDs, item.ID)
	}
	imageTasks, err := repository.ListImageTasksForOperations(operationIDs)
	if err != nil {
		return model.OperationLogList{}, err
	}
	imagesByOperation := make(map[string]model.ImageGenerationTask, len(imageTasks))
	for _, task := range imageTasks {
		imagesByOperation[task.OperationLogID] = task
	}
	tasks, err := repository.ListVideoTasksForOperations(operationIDs)
	if err != nil {
		return model.OperationLogList{}, err
	}
	byOperation := make(map[string]model.VideoGenerationTask, len(tasks))
	for _, task := range tasks {
		byOperation[task.OperationLogID] = task
	}
	for index := range items {
		if task, ok := imagesByOperation[items[index].ID]; ok {
			items[index].RequestSummary = ""
			items[index].Image = imageOperationDetails(task)
			items[index].ProviderTaskID = task.ProviderTaskID
			if strings.TrimSpace(task.ErrorMessage) != "" {
				items[index].ErrorMessage = safeAuditError(task.ErrorMessage)
			}
		}
		if task, ok := byOperation[items[index].ID]; ok {
			// Replace the historical raw request with the explicit safe DTO.
			items[index].RequestSummary = ""
			items[index].Video = videoOperationDetails(task)
			items[index].ProviderTaskID = task.ProviderTaskID
		}
		if items[index].ActorRoles == nil {
			items[index].ActorRoles = []string{}
		}
		if items[index].MediaIDs == nil {
			items[index].MediaIDs = []string{}
		}
	}
	return model.OperationLogList{Items: items, Total: int(total)}, nil
}

func imageOperationDetails(task model.ImageGenerationTask) *model.ImageOperationDetails {
	return &model.ImageOperationDetails{
		TaskID: task.ID, Status: string(task.Status), ProviderID: task.ProviderID, ProviderName: task.ProviderName,
		ProviderTaskID: task.ProviderTaskID, Quality: task.Quality, Size: task.Size, Resolution: task.Resolution,
		OutputFormat: task.OutputFormat, Background: task.Background, Amount: task.Amount,
	}
}

func CleanupExpiredOperationLogs(now time.Time) error {
	return repository.DeleteExpiredOperationLogs(now.UTC())
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

func videoOperationDetails(task model.VideoGenerationTask) *model.VideoOperationDetails {
	var request struct {
		Seconds       int    `json:"seconds"`
		Size          string `json:"size"`
		Resolution    string `json:"resolution"`
		GenerateAudio bool   `json:"generateAudio"`
	}
	// Corrupt historical snapshots expose no raw request data.
	_ = json.Unmarshal([]byte(task.RequestJSON), &request)
	return &model.VideoOperationDetails{TaskID: task.ID, Status: task.Status, ProviderID: task.ProviderID, ProviderName: task.ProviderName, ProviderTaskID: task.ProviderTaskID, Seconds: request.Seconds, Size: request.Size, Resolution: request.Resolution, GenerateAudio: request.GenerateAudio, Amount: task.Amount}
}
