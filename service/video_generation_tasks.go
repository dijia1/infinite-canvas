package service

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
	"strconv"
	"strings"
	"time"
)

type CreateVideoTaskRequest struct {
	Mode              string   `json:"mode,omitempty"`
	SourceDraftTaskID string   `json:"sourceDraftTaskId,omitempty"`
	ReplaceTaskID     string   `json:"replaceTaskId,omitempty"`
	ConfirmUncertain  bool     `json:"confirmUncertain,omitempty"`
	ClientRequestID   string   `json:"clientRequestId"`
	ProviderID        string   `json:"providerId"`
	Prompt            string   `json:"prompt"`
	Seconds           int      `json:"seconds"`
	Size              string   `json:"size"`
	Resolution        string   `json:"resolution"`
	GenerateAudio     bool     `json:"generateAudio"`
	ImageMediaIDs     []string `json:"imageMediaIds"`
	VideoMediaIDs     []string `json:"videoMediaIds"`
}
type VideoTaskView struct {
	ID              string                     `json:"id"`
	ClientRequestID string                     `json:"clientRequestId"`
	Status          string                     `json:"status"`
	Progress        int                        `json:"progress"`
	Error           string                     `json:"error,omitempty"`
	Issue           *model.GenerationTaskIssue `json:"issue,omitempty"`
	ResultMediaIDs  []string                   `json:"resultMediaIds"`
	Videos          []MediaAccess              `json:"videos"`
}

func validateVideoTaskRequest(request CreateVideoTaskRequest) error {
	_, err := normalizeVideoTaskRequest(request)
	return err
}

func normalizeVideoTaskRequest(request CreateVideoTaskRequest) (CreateVideoTaskRequest, error) {
	request.ClientRequestID = strings.TrimSpace(request.ClientRequestID)
	request.ProviderID = strings.TrimSpace(request.ProviderID)
	request.Prompt = strings.TrimSpace(request.Prompt)
	request.Mode = strings.TrimSpace(request.Mode)
	if request.Mode == "normal" {
		request.Mode = ""
	}
	request.SourceDraftTaskID = strings.TrimSpace(request.SourceDraftTaskID)
	if request.Mode != "" && request.Mode != "draft" && request.Mode != "final" {
		return CreateVideoTaskRequest{}, safeMessageError{message: "视频生成模式无效"}
	}
	if request.Mode == "final" && (request.SourceDraftTaskID == "" || len(request.SourceDraftTaskID) > 128) || request.Mode != "final" && request.SourceDraftTaskID != "" {
		return CreateVideoTaskRequest{}, safeMessageError{message: "请选择有效的来源样片"}
	}
	request.Size = strings.TrimSpace(request.Size)
	request.Resolution = strings.TrimSpace(request.Resolution)
	request.ImageMediaIDs = append([]string{}, request.ImageMediaIDs...)
	request.VideoMediaIDs = append([]string{}, request.VideoMediaIDs...)
	if request.ClientRequestID == "" || len(request.ClientRequestID) > 128 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "视频请求 ID 无效"}
	}
	if request.Mode != "final" && request.Prompt == "" || len(request.Prompt) > 20000 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "请填写有效的视频提示词"}
	}
	if request.Mode != "final" && request.Seconds < 1 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "生成视频时长必须为正整数"}
	}
	for _, ids := range [][]string{request.ImageMediaIDs, request.VideoMediaIDs} {
		for index, id := range ids {
			ids[index] = strings.TrimSpace(id)
			if ids[index] == "" || len(ids[index]) > 128 {
				return CreateVideoTaskRequest{}, safeMessageError{message: "参考素材无效"}
			}
		}
	}
	return request, nil
}
func videoTaskAmount(provider model.AIProvider, request CreateVideoTaskRequest) (decimal.Decimal, error) {
	validRatio := false
	for _, ratio := range provider.AspectRatios {
		if ratio == request.Size {
			validRatio = true
		}
	}
	if !validRatio {
		return decimal.Zero, safeMessageError{message: "请选择模型支持的比例"}
	}
	for _, price := range provider.VideoPrices {
		if price.Resolution == request.Resolution {
			return price.Amount.Mul(decimal.NewFromInt(int64(request.Seconds))), nil
		}
	}
	return decimal.Zero, safeMessageError{message: "请选择已配置价格的视频分辨率"}
}
func CreateVideoGenerationTask(ctx context.Context, request CreateVideoTaskRequest) (VideoTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || user.UID == "" {
		return VideoTaskView{}, safeMessageError{message: "未登录"}
	}
	request, err := normalizeVideoTaskRequest(request)
	if err != nil {
		return VideoTaskView{}, err
	}
	previous, previousFound, err := repository.GetVideoGenerationTaskByClient(user.UID, request.ClientRequestID)
	if err != nil {
		return VideoTaskView{}, err
	}
	if previousFound && previous.RequestHash == "" {
		return videoGenerationTaskView(ctx, user, previous)
	}
	if previousFound {
		if request.ProviderID == "" {
			request.ProviderID = previous.ProviderID
		}
		requestHash, err := videoTaskRequestHash(request)
		if err != nil {
			return VideoTaskView{}, err
		}
		if previous.RequestHash != requestHash {
			return VideoTaskView{}, ErrGenerationRequestConflict
		}
		return videoGenerationTaskView(ctx, user, previous)
	}
	if request.Mode == "final" {
		request, _, err = resolveDraftVideoRequest(user, request)
		if err != nil {
			return VideoTaskView{}, err
		}
	}
	settings, err := AdminSettings()
	if err != nil {
		return VideoTaskView{}, err
	}
	if request.ProviderID == "" {
		request.ProviderID = settings.AI.VideoProviderID
	}
	provider, found := findProvider(settings.AI, request.ProviderID)
	if !found || !providerAvailable(settings.AI, request.ProviderID, ai.CapabilityVideoGenerate) {
		return VideoTaskView{}, safeMessageError{message: "视频模型不可用"}
	}
	request.ProviderID = provider.ID
	providerType, found := ai.Type(provider.Type)
	if !found {
		return VideoTaskView{}, safeMessageError{message: "视频模型不可用"}
	}
	if err := validateVideoRequestCapabilities(request, provider, providerType); err != nil {
		return VideoTaskView{}, err
	}
	requestHash, err := videoTaskRequestHash(request)
	if err != nil {
		return VideoTaskView{}, err
	}
	amount, err := videoTaskAmount(provider, request)
	if err != nil {
		return VideoTaskView{}, err
	}
	if _, err := resolveVideoTaskInputs(ctx, user, request, providerType.VideoRequestSchema); err != nil {
		return VideoTaskView{}, err
	}
	timeout, err := videoTaskTimeout()
	if err != nil {
		return VideoTaskView{}, err
	}
	current := time.Now().UTC()
	body, _ := json.Marshal(request)
	inputs := append(append([]string{}, request.ImageMediaIDs...), request.VideoMediaIDs...)
	inputJSON, _ := json.Marshal(inputs)
	item := model.VideoGenerationTask{ID: newID("video-task"), OwnerUID: user.UID, ClientRequestID: request.ClientRequestID, RequestHash: requestHash, Status: "queued", ProviderID: provider.ID, ProviderName: provider.Name, ProviderType: provider.Type, ProviderConfig: string(provider.Config), RequestJSON: string(body), InputMediaIDsJSON: string(inputJSON), ResultMediaIDsJSON: "[]", ResultURLsJSON: "[]", Amount: amount, OperationLogID: newID("operation"), CreatedAt: current, UpdatedAt: current, NextPollAt: current, Deadline: current.Add(timeout)}
	operation := model.OperationLog{ID: item.OperationLogID, ActorUID: user.UID, ActorName: PortalDisplayName(user), ActorRoles: user.Roles, Action: "video_generate", Status: model.OperationStatusSubmitted, TargetType: "video_generation", TargetID: item.ID, Prompt: request.Prompt, RequestSummary: string(body), CreatedAt: current}
	replacement, err := taskReplacement(user, "video", request.ReplaceTaskID, request.ClientRequestID, request.ConfirmUncertain)
	if err != nil {
		return VideoTaskView{}, err
	}
	item, err = repository.CreateVideoGenerationTask(item, operation, inputs, replacement)
	if err != nil {
		return VideoTaskView{}, generationReplacementError(err)
	}
	return videoGenerationTaskView(ctx, user, item)
}

func validateVideoRequestCapabilities(request CreateVideoTaskRequest, provider model.AIProvider, info ai.ProviderType) error {
	schema := configuredVideoRequestSchema(provider, info)
	if request.Mode != "" && !schema.SupportsDraft {
		return safeMessageError{message: "当前模型不支持样片或正式片"}
	}
	if request.Mode == "draft" && request.Resolution != "480p" {
		return safeMessageError{message: "样片必须使用 480p"}
	}
	if request.Mode == "final" && request.Resolution != "1080p" {
		return safeMessageError{message: "正式片必须使用 1080p"}
	}
	if request.Seconds < schema.MinDuration || request.Seconds > schema.MaxDuration {
		return safeMessageError{message: "请选择当前模型支持的视频时长"}
	}
	if len(request.ImageMediaIDs) > schema.MaxReferenceImages {
		return safeMessageError{message: "参考图片数量超过当前模型上限"}
	}
	if len(request.VideoMediaIDs) > schema.MaxReferenceVideos {
		return safeMessageError{message: "当前模型不支持这么多参考视频"}
	}
	if request.GenerateAudio && !schema.SupportsAudio {
		return safeMessageError{message: "当前模型不支持生成音频"}
	}
	_, err := videoTaskAmount(provider, request)
	return err
}
func GetVideoGenerationTask(ctx context.Context, id string) (VideoTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || user.UID == "" {
		return VideoTaskView{}, safeMessageError{message: "未登录"}
	}
	item, found, err := repository.GetVideoGenerationTask(id, user.UID)
	if err != nil {
		return VideoTaskView{}, err
	}
	if !found {
		return VideoTaskView{}, safeMessageError{message: "视频任务不存在"}
	}
	return videoGenerationTaskView(ctx, user, item)
}
func ResumeVideoGenerationTask(ctx context.Context, id string) (VideoTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || user.UID == "" {
		return VideoTaskView{}, safeMessageError{message: "未登录"}
	}
	timeout, err := videoTaskTimeout()
	if err != nil {
		return VideoTaskView{}, err
	}
	item, found, err := repository.GetVideoGenerationTask(id, user.UID)
	if err != nil {
		return VideoTaskView{}, err
	}
	if !found || item.OwnerUID != user.UID {
		return VideoTaskView{}, safeMessageError{message: "任务不存在"}
	}
	credentials, err := refreshedGenerationCredentials(item.ProviderID, item.ProviderType, item.ProviderConfig)
	if err != nil {
		return VideoTaskView{}, err
	}
	global, _ := workflowConcurrency()
	if err := repository.ResumeVideoGenerationTask(id, user.UID, time.Now().UTC(), timeout, global, credentials); err != nil {
		return VideoTaskView{}, generationResumeError(err)
	}
	return GetVideoGenerationTask(ctx, id)
}
func videoGenerationTaskView(ctx context.Context, user PortalUser, item model.VideoGenerationTask) (VideoTaskView, error) {
	view := VideoTaskView{ID: item.ID, ClientRequestID: item.ClientRequestID, Status: item.Status, Progress: item.Progress, Error: item.Error, Issue: videoGenerationTaskIssue(item), ResultMediaIDs: []string{}, Videos: []MediaAccess{}}
	if err := json.Unmarshal([]byte(item.ResultMediaIDsJSON), &view.ResultMediaIDs); err != nil {
		return view, err
	}
	if item.Status == "succeeded" {
		for _, id := range view.ResultMediaIDs {
			access, err := MediaAccessURL(ctx, user, id)
			if err != nil {
				return view, err
			}
			view.Videos = append(view.Videos, access)
		}
	}
	return view, nil
}
func resolveVideoTaskInputs(ctx context.Context, user PortalUser, request CreateVideoTaskRequest, schema *ai.VideoRequestSchema) (ai.VideoRequest, error) {
	if request.Mode == "final" {
		resolved, source, err := resolveDraftVideoRequest(user, request)
		if err != nil {
			return ai.VideoRequest{}, err
		}
		return ai.VideoRequest{Mode: "final", DraftTaskID: source.ProviderTaskID, Seconds: strconv.Itoa(resolved.Seconds), Size: resolved.Size, Resolution: "1080p"}, nil
	}
	store, err := newImageStore()
	if err != nil {
		return ai.VideoRequest{}, err
	}
	result := ai.VideoRequest{Mode: request.Mode, Prompt: request.Prompt, Seconds: strconv.Itoa(request.Seconds), Size: request.Size, Resolution: request.Resolution, GenerateAudio: request.GenerateAudio}
	if _, ok := store.(*ossImageStore); !ok {
		return result, safeMessageError{message: "视频生成需要 OSS 存储"}
	}
	maxVideoDuration := 15
	if schema != nil {
		maxVideoDuration = schema.MaxReferenceVideoDuration
	}
	duration := 0.0
	for group, ids := range [][]string{request.ImageMediaIDs, request.VideoMediaIDs} {
		for _, id := range ids {
			item, found, err := repository.GetMedia(id)
			if err != nil {
				return result, err
			}
			if !found || item.CleanupStatus != model.MediaCleanupActive {
				return result, safeMessageError{message: "参考素材不存在或正在删除"}
			}
			if item.OwnerUID != user.UID {
				_, public, err := repository.GetPublicImageByMediaID(id)
				if err != nil {
					return result, err
				}
				if !public || group == 1 {
					return result, safeMessageError{message: "无权使用参考素材"}
				}
			}
			if group == 0 && !strings.HasPrefix(item.ContentType, "image/") || group == 1 && item.ContentType != "video/mp4" {
				return result, safeMessageError{message: "参考素材类型不匹配"}
			}
			if group == 1 {
				if item.Duration <= 0 {
					return result, safeMessageError{message: "参考视频缺少时长信息，请重新上传"}
				}
				duration += item.Duration
				if maxVideoDuration > 0 && duration > float64(maxVideoDuration)+0.000001 {
					return result, safeMessageError{message: fmt.Sprintf("参考视频总时长不能超过 %d 秒", maxVideoDuration)}
				}
			}
			url, err := videoReferenceURL(ctx, store, item.ObjectKey)
			if err != nil {
				return result, err
			}
			if group == 0 {
				result.ImageURLs = append(result.ImageURLs, url)
			} else {
				result.VideoURLs = append(result.VideoURLs, url)
			}
		}
	}
	return result, nil
}

func GetVideoGenerationTaskByClient(ctx context.Context, client string) (VideoTaskView, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || user.UID == "" {
		return VideoTaskView{}, safeMessageError{message: "未登录"}
	}
	item, found, err := repository.GetVideoGenerationTaskByClient(user.UID, client)
	if err != nil {
		return VideoTaskView{}, err
	}
	if !found {
		return VideoTaskView{}, safeMessageError{message: "视频任务不存在"}
	}
	return videoGenerationTaskView(ctx, user, item)
}
