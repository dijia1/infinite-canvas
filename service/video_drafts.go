package service

import (
	"context"
	"encoding/json"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

// Only the local task identity is exposed. Supplier IDs and credentials stay on the server.
type VideoGenerationSource struct {
	TaskID        string    `json:"taskId"`
	ProviderID    string    `json:"providerId"`
	Mode          string    `json:"mode"`
	CreatedAt     time.Time `json:"createdAt"`
	Seconds       int       `json:"seconds"`
	Size          string    `json:"size"`
	GenerateAudio bool      `json:"generateAudio"`
}

func mediaVideoGenerationSource(media model.Media) (*VideoGenerationSource, error) {
	if media.GenerationTaskID == "" {
		return nil, nil
	}
	task, found, err := repository.GetVideoGenerationTask(media.GenerationTaskID, media.OwnerUID)
	if err != nil {
		return nil, err
	}
	if !found || task.ProviderType != "maizi-video-seedance-2-5" || task.Status != "succeeded" {
		return nil, nil
	}
	var request CreateVideoTaskRequest
	if err = json.Unmarshal([]byte(task.RequestJSON), &request); err != nil {
		return nil, err
	}
	return &VideoGenerationSource{TaskID: task.ID, ProviderID: task.ProviderID, Mode: request.Mode, CreatedAt: task.CreatedAt, Seconds: request.Seconds, Size: request.Size, GenerateAudio: request.GenerateAudio}, nil
}

func resolveDraftVideoRequest(user PortalUser, request CreateVideoTaskRequest) (CreateVideoTaskRequest, model.VideoGenerationTask, error) {
	source, found, err := repository.GetVideoGenerationTask(request.SourceDraftTaskID, user.UID)
	if err != nil {
		return request, source, err
	}
	if !found || source.Status != "succeeded" || source.ProviderType != "maizi-video-seedance-2-5" {
		return request, source, safeMessageError{message: "请选择本人已完成的 Seedance 2.5 样片"}
	}
	var original CreateVideoTaskRequest
	if err = json.Unmarshal([]byte(source.RequestJSON), &original); err != nil {
		return request, source, err
	}
	if original.Mode != "draft" {
		return request, source, safeMessageError{message: "来源视频不是样片"}
	}
	if _, err = uuid.Parse(source.ProviderTaskID); err != nil {
		return request, source, safeMessageError{message: "样片缺少有效的供应商任务记录"}
	}
	if request.ProviderID != "" && request.ProviderID != source.ProviderID {
		return request, source, safeMessageError{message: "正式片必须使用样片的原供应商"}
	}
	// Formal generation inherits the immutable sample snapshot. No original media
	// needs to be signed or downloaded again, and no draft video is sent as input.
	request.ProviderID = source.ProviderID
	request.Prompt = original.Prompt
	request.Seconds = original.Seconds
	request.Size = original.Size
	request.Resolution = "1080p"
	request.GenerateAudio = original.GenerateAudio
	request.ImageMediaIDs = nil
	request.VideoMediaIDs = nil
	return request, source, nil
}

func validateWorkflowDraftSource(ctx context.Context, graph model.WorkflowGraph, node model.WorkflowNode) error {
	connections := []model.WorkflowConnection{}
	for _, c := range graph.Connections {
		if c.TargetNodeID == node.ID {
			connections = append(connections, c)
		}
	}
	if len(connections) != 1 {
		return workflowValidationError{message: "正式片必须且只能连接一个样片视频"}
	}
	var source model.WorkflowNode
	for _, n := range graph.Nodes {
		if n.ID == connections[0].SourceNodeID {
			source = n
		}
	}
	settings, err := AdminSettings()
	if err != nil {
		return err
	}
	provider, found := findProvider(settings.AI, node.Config.ProviderID)
	if !found {
		return workflowValidationError{message: "正式片模型不可用"}
	}
	info, found := ai.Type(provider.Type)
	if !found || info.VideoRequestSchema == nil || !info.VideoRequestSchema.SupportsDraft {
		return workflowValidationError{message: "当前模型不支持正式片"}
	}
	if source.Type == model.WorkflowNodeVideoInput {
		media, found, err := repository.GetMedia(source.MediaID)
		if err != nil {
			return err
		}
		if !found {
			return workflowValidationError{message: "来源样片不存在"}
		}
		user, _ := PortalUserFromContext(ctx)
		req, _, err := resolveDraftVideoRequest(user, CreateVideoTaskRequest{Mode: "final", SourceDraftTaskID: media.GenerationTaskID, ProviderID: provider.ID})
		if err != nil {
			return err
		}
		return validateVideoRequestCapabilities(req, provider, info)
	}
	if source.Type != model.WorkflowNodeVideoGeneration || source.Config == nil || source.Config.VideoMode != "draft" || source.Config.ProviderID != node.Config.ProviderID {
		return workflowValidationError{message: "正式片只能连接同一供应商的样片输出"}
	}
	if _, err := info.New(provider.Config); err != nil {
		return workflowRunValidationError(err, "视频模型配置无效")
	}
	seconds := 5
	if source.Config.Seconds != nil {
		seconds = *source.Config.Seconds
	}
	return validateVideoRequestCapabilities(CreateVideoTaskRequest{Mode: "final", Seconds: seconds, Size: source.Config.Size, Resolution: "1080p"}, provider, info)
}
