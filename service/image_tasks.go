package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	ImageTaskModeGeneration = "generation"
	ImageTaskModeEdit       = "edit"
)

type CreateImageTaskRequest struct {
	ClientRequestID string
	Mode            string
	Request         ai.ImageRequest
	References      []ai.ImageReference
	Mask            *ai.ImageReference
}

type ImageTaskView struct {
	ID              string        `json:"id"`
	ClientRequestID string        `json:"clientRequestId"`
	Status          string        `json:"status"`
	Progress        int           `json:"progress"`
	Error           string        `json:"error,omitempty"`
	Images          []MediaAccess `json:"images"`
}

// CreateImageTask persists one image request before a worker contacts the
// supplier. A client request ID makes retries safe when the browser loses the
// create response.
func CreateImageTask(ctx context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || strings.TrimSpace(user.UID) == "" {
		return ImageTaskView{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	request, err := normalizeImageTaskRequest(request)
	if err != nil {
		return ImageTaskView{}, err
	}

	if existing, found, err := repository.GetImageGenerationTaskByClientRequest(user.UID, request.ClientRequestID); err != nil {
		return ImageTaskView{}, err
	} else if found {
		return imageTaskView(ctx, user, existing)
	}

	provider, err := selectedImageTaskProvider(request.Mode)
	if err != nil {
		return ImageTaskView{}, err
	}
	requestSummary, err := summarizeImageTaskRequest(provider, ai.ImageTaskRequest{Request: request.Request, References: request.References, Mask: request.Mask})
	if err != nil {
		return ImageTaskView{}, err
	}
	taskID := newID("image-task")
	operationLogID := newID("operation")
	inputs, err := SaveImageTaskInputs(ctx, taskID, request.References, request.Mask)
	if err != nil {
		return ImageTaskView{}, err
	}
	inputsJSON, err := json.Marshal(inputs)
	if err != nil {
		_ = DeleteImageTaskInputs(ctx, inputs)
		return ImageTaskView{}, err
	}
	item := model.ImageGenerationTask{
		ID: taskID, OwnerUID: user.UID, ClientRequestID: request.ClientRequestID, Mode: request.Mode,
		Status: model.ImageTaskQueued, ProviderID: provider.ID, ProviderType: provider.Type, ProviderConfig: string(provider.Config),
		Prompt: request.Request.Prompt, Quality: strings.TrimSpace(request.Request.Quality), Size: strings.TrimSpace(request.Request.Size), Resolution: strings.TrimSpace(request.Request.Resolution), OutputFormat: request.Request.OutputFormat, Background: request.Request.Background, Count: 1,
		ReferencesJSON: string(inputsJSON), RequestSummary: requestSummary, OperationLogID: operationLogID, CreatedAt: now(), UpdatedAt: now(),
	}
	operation := model.OperationLog{
		ID: operationLogID, ActorUID: user.UID, ActorName: PortalDisplayName(user), ActorRoles: append([]string{}, user.Roles...),
		Action: imageTaskAction(item), Status: model.OperationStatusSubmitted, TargetType: "image_generation", TargetID: item.ID,
		Prompt: item.Prompt, RequestSummary: requestSummary, CreatedAt: time.Now().UTC(),
	}
	created, inserted, err := repository.CreateImageGenerationTaskWithOperationLog(item, operation)
	if err != nil {
		_ = DeleteImageTaskInputs(ctx, inputs)
		return ImageTaskView{}, err
	}
	if !inserted {
		_ = DeleteImageTaskInputs(ctx, inputs)
	}
	return imageTaskView(ctx, user, created)
}

func summarizeImageTaskRequest(provider model.AIProvider, request ai.ImageTaskRequest) (string, error) {
	typeInfo, ok := ai.Type(strings.TrimSpace(provider.Type))
	if !ok || typeInfo.New == nil {
		return "", errors.New("当前供应商未实现请求审计")
	}
	instance, err := typeInfo.New(provider.Config)
	if err != nil {
		return "", err
	}
	summarizer, ok := instance.(ai.ImageTaskRequestSummarizer)
	if !ok {
		return "", errors.New("当前供应商未实现请求审计")
	}
	summary, err := summarizer.SummarizeImageTaskRequest(request)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func normalizeImageTaskRequest(request CreateImageTaskRequest) (CreateImageTaskRequest, error) {
	request.ClientRequestID = strings.TrimSpace(request.ClientRequestID)
	if request.ClientRequestID == "" || len(request.ClientRequestID) > 128 {
		return CreateImageTaskRequest{}, safeMessageError{message: "客户端请求 ID 无效"}
	}
	request.Mode = strings.TrimSpace(request.Mode)
	if request.Mode != ImageTaskModeGeneration && request.Mode != ImageTaskModeEdit {
		return CreateImageTaskRequest{}, safeMessageError{message: "图片任务类型无效"}
	}
	request.Request.Prompt = strings.TrimSpace(request.Request.Prompt)
	if request.Request.Prompt == "" {
		return CreateImageTaskRequest{}, safeMessageError{message: "提示词不能为空"}
	}
	if request.Request.Count < 1 {
		request.Request.Count = 1
	}
	if request.Request.Count != 1 {
		return CreateImageTaskRequest{}, safeMessageError{message: "单次图片任务只能生成一张图片"}
	}
	if request.Mode == ImageTaskModeEdit && (len(request.References) < 1 || len(request.References) > 7) {
		return CreateImageTaskRequest{}, safeMessageError{message: "图像编辑需要 1–7 张参考图"}
	}
	if request.Mask != nil && request.Mode != ImageTaskModeEdit {
		return CreateImageTaskRequest{}, safeMessageError{message: "遮罩只能用于图像编辑"}
	}
	format := strings.ToLower(strings.TrimSpace(request.Request.OutputFormat))
	background := strings.ToLower(strings.TrimSpace(request.Request.Background))
	if format == "" {
		format = "jpeg"
	}
	if background == "" {
		background = "auto"
	}
	if (format != "jpeg" && format != "png") || (background != "auto" && background != "opaque" && background != "transparent") || (format == "jpeg" && background == "transparent") {
		return CreateImageTaskRequest{}, safeMessageError{message: fmt.Sprintf("图片输出格式与背景组合无效：%s/%s", format, background)}
	}
	request.Request.OutputFormat, request.Request.Background = format, background
	return request, nil
}

func GetImageTask(ctx context.Context, id string) (ImageTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || strings.TrimSpace(user.UID) == "" {
		return ImageTaskView{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	item, found, err := repository.GetImageGenerationTaskForOwner(strings.TrimSpace(id), user.UID)
	if err != nil {
		return ImageTaskView{}, err
	}
	if !found {
		return ImageTaskView{}, safeMessageError{message: "图片任务不存在"}
	}
	return imageTaskView(ctx, user, item)
}

func GetImageTaskByClientRequest(ctx context.Context, clientRequestID string) (ImageTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || strings.TrimSpace(user.UID) == "" {
		return ImageTaskView{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	item, found, err := repository.GetImageGenerationTaskByClientRequest(user.UID, strings.TrimSpace(clientRequestID))
	if err != nil {
		return ImageTaskView{}, err
	}
	if !found {
		return ImageTaskView{}, safeMessageError{message: "图片任务不存在"}
	}
	return imageTaskView(ctx, user, item)
}

func imageTaskView(ctx context.Context, user PortalUser, item model.ImageGenerationTask) (ImageTaskView, error) {
	view := ImageTaskView{
		ID: item.ID, ClientRequestID: item.ClientRequestID, Status: string(item.Status), Progress: item.Progress,
		Error: strings.TrimSpace(item.ErrorMessage), Images: []MediaAccess{},
	}
	if item.Status != model.ImageTaskSucceeded || strings.TrimSpace(item.ResultMediaIDsJSON) == "" {
		return view, nil
	}
	var mediaIDs []string
	if err := json.Unmarshal([]byte(item.ResultMediaIDsJSON), &mediaIDs); err != nil {
		return ImageTaskView{}, err
	}
	for _, mediaID := range mediaIDs {
		access, err := MediaAccessURL(ctx, user, mediaID)
		if err != nil {
			return ImageTaskView{}, err
		}
		view.Images = append(view.Images, access)
	}
	return view, nil
}

func selectedImageTaskProvider(mode string) (model.AIProvider, error) {
	settings, err := AdminSettings()
	if err != nil {
		return model.AIProvider{}, err
	}
	provider, ok := findProvider(settings.AI, settings.AI.ImageProviderID)
	if !ok || !provider.Enabled {
		return model.AIProvider{}, safeMessageError{message: "当前供应商不可用"}
	}
	typeInfo, ok := ai.Type(provider.Type)
	if !ok {
		return model.AIProvider{}, safeMessageError{message: "当前供应商未实现"}
	}
	capability := ai.CapabilityImageGenerate
	if mode == ImageTaskModeEdit {
		capability = ai.CapabilityImageEdit
	}
	if !typeInfo.Supports(capability) {
		if mode == ImageTaskModeEdit {
			return model.AIProvider{}, safeMessageError{message: "当前生图供应商不支持图像编辑"}
		}
		return model.AIProvider{}, safeMessageError{message: "当前供应商不支持此能力"}
	}
	if typeInfo.New == nil {
		return model.AIProvider{}, safeMessageError{message: "当前供应商未实现"}
	}
	instance, err := typeInfo.New(provider.Config)
	if err != nil {
		return model.AIProvider{}, err
	}
	if _, ok := instance.(ai.ImageTaskProvider); !ok {
		return model.AIProvider{}, safeMessageError{message: "当前供应商未实现异步图片任务"}
	}
	if _, ok := instance.(ai.ImageTaskRequestSummarizer); !ok {
		return model.AIProvider{}, safeMessageError{message: "当前供应商未实现请求审计"}
	}
	return provider, nil
}

func imageTaskProvider(item model.ImageGenerationTask) (ai.ImageTaskProvider, ai.ImageTaskRequestSummarizer, error) {
	typeInfo, ok := ai.Type(strings.TrimSpace(item.ProviderType))
	if !ok || typeInfo.New == nil {
		return nil, nil, errors.New("任务绑定的供应商已不可用")
	}
	provider, err := typeInfo.New(json.RawMessage(item.ProviderConfig))
	if err != nil {
		return nil, nil, err
	}
	result, ok := provider.(ai.ImageTaskProvider)
	if !ok {
		return nil, nil, errors.New("任务绑定的供应商未实现异步图片任务")
	}
	summarizer, ok := provider.(ai.ImageTaskRequestSummarizer)
	if !ok {
		return nil, nil, errors.New("任务绑定的供应商未实现请求审计")
	}
	return result, summarizer, nil
}

func imageTaskRequest(item model.ImageGenerationTask) ai.ImageRequest {
	format := strings.TrimSpace(item.OutputFormat)
	background := strings.TrimSpace(item.Background)
	if format == "" && background == "" {
		format, background = "jpeg", "auto"
	}
	return ai.ImageRequest{Prompt: item.Prompt, Count: item.Count, Quality: item.Quality, Size: item.Size, Resolution: item.Resolution, OutputFormat: format, Background: background}
}

func imageTaskInputs(item model.ImageGenerationTask) ([]ImageTaskInput, error) {
	if strings.TrimSpace(item.ReferencesJSON) == "" {
		return []ImageTaskInput{}, nil
	}
	var inputs []ImageTaskInput
	if err := json.Unmarshal([]byte(item.ReferencesJSON), &inputs); err != nil {
		return nil, err
	}
	return inputs, nil
}
