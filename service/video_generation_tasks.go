package service

import (
	"context"
	"encoding/json"
	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
	"strconv"
	"strings"
	"time"
)

type CreateVideoTaskRequest struct {
	ClientRequestID string   `json:"clientRequestId"`
	ProviderID      string   `json:"providerId"`
	Prompt          string   `json:"prompt"`
	Seconds         int      `json:"seconds"`
	Size            string   `json:"size"`
	Resolution      string   `json:"resolution"`
	GenerateAudio   bool     `json:"generateAudio"`
	ImageMediaIDs   []string `json:"imageMediaIds"`
	VideoMediaIDs   []string `json:"videoMediaIds"`
}
type VideoTaskView struct {
	ID              string        `json:"id"`
	ClientRequestID string        `json:"clientRequestId"`
	Status          string        `json:"status"`
	Progress        int           `json:"progress"`
	Error           string        `json:"error,omitempty"`
	ResultMediaIDs  []string      `json:"resultMediaIds"`
	Videos          []MediaAccess `json:"videos"`
}

func validateVideoTaskRequest(request CreateVideoTaskRequest) error {
	_, err := normalizeVideoTaskRequest(request)
	return err
}

func normalizeVideoTaskRequest(request CreateVideoTaskRequest) (CreateVideoTaskRequest, error) {
	request.ClientRequestID = strings.TrimSpace(request.ClientRequestID)
	request.ProviderID = strings.TrimSpace(request.ProviderID)
	request.Prompt = strings.TrimSpace(request.Prompt)
	request.Size = strings.TrimSpace(request.Size)
	request.Resolution = strings.TrimSpace(request.Resolution)
	request.ImageMediaIDs = append([]string{}, request.ImageMediaIDs...)
	request.VideoMediaIDs = append([]string{}, request.VideoMediaIDs...)
	if request.ClientRequestID == "" || len(request.ClientRequestID) > 128 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "视频请求 ID 无效"}
	}
	if request.Prompt == "" || len(request.Prompt) > 20000 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "请填写有效的视频提示词"}
	}
	if request.Seconds < 4 || request.Seconds > 15 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "生成视频时长必须为 4–15 秒"}
	}
	if len(request.ImageMediaIDs) > 9 || len(request.VideoMediaIDs) > 3 {
		return CreateVideoTaskRequest{}, safeMessageError{message: "最多支持 9 张参考图片和 3 个参考视频"}
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
	requestHash, err := videoTaskRequestHash(request)
	if err != nil {
		return VideoTaskView{}, err
	}
	amount, err := videoTaskAmount(provider, request)
	if err != nil {
		return VideoTaskView{}, err
	}
	if _, err := resolveVideoTaskInputs(ctx, user, request); err != nil {
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
	item, err = repository.CreateVideoGenerationTask(item, operation, inputs)
	if err != nil {
		return VideoTaskView{}, err
	}
	return videoGenerationTaskView(ctx, user, item)
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
	if err := repository.ResumeVideoGenerationTask(id, user.UID, time.Now().UTC(), timeout); err != nil {
		return VideoTaskView{}, err
	}
	return GetVideoGenerationTask(ctx, id)
}
func videoGenerationTaskView(ctx context.Context, user PortalUser, item model.VideoGenerationTask) (VideoTaskView, error) {
	view := VideoTaskView{ID: item.ID, ClientRequestID: item.ClientRequestID, Status: item.Status, Progress: item.Progress, Error: item.Error, ResultMediaIDs: []string{}, Videos: []MediaAccess{}}
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
func resolveVideoTaskInputs(ctx context.Context, user PortalUser, request CreateVideoTaskRequest) (ai.VideoRequest, error) {
	store, err := newImageStore()
	if err != nil {
		return ai.VideoRequest{}, err
	}
	result := ai.VideoRequest{ProviderID: request.ProviderID, Prompt: request.Prompt, Seconds: strconv.Itoa(request.Seconds), Size: request.Size, Resolution: request.Resolution, GenerateAudio: request.GenerateAudio}
	if _, ok := store.(*ossImageStore); !ok {
		return result, safeMessageError{message: "视频生成需要 OSS 存储"}
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
				seconds, _, _, err := probeStoredVideo(ctx, store, item.ObjectKey)
				if err != nil {
					return result, err
				}
				duration += seconds
				if duration > 15.000001 {
					return result, safeMessageError{message: "参考视频总时长不能超过 15 秒"}
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
