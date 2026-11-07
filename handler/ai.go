package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/service"
)

const workflowRequestIDPrefix = "workflow-"

type imageRequest struct {
	ReplaceTaskID     string          `json:"replaceTaskId"`
	ConfirmUncertain  bool            `json:"confirmUncertain"`
	ClientRequestID   string          `json:"clientRequestId"`
	ProviderID        string          `json:"providerId"`
	Prompt            string          `json:"prompt"`
	N                 int             `json:"n"`
	Quality           string          `json:"quality"`
	Size              string          `json:"size"`
	Resolution        string          `json:"resolution"`
	OutputFormat      string          `json:"output_format"`
	Background        string          `json:"background"`
	ProviderOptions   json.RawMessage `json:"providerOptions"`
	ReferenceMediaIDs []string        `json:"referenceMediaIds"`
	MaskMediaID       string          `json:"maskMediaId"`
}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	var payload imageRequest
	if err := decodeJSONBody(w, r, &payload, maxGenerationRequestBytes, false); err != nil {
		writeJSONRequestError(w, err, "图片生成请求无效")
		return
	}
	if rejectReservedWorkflowRequestID(w, payload.ClientRequestID) {
		return
	}
	options, err := imageRequestOptionsFromJSON(payload.ProviderOptions)
	if err != nil {
		Fail(w, "供应商参数无效")
		return
	}
	task, err := service.CreateImageTask(r.Context(), service.CreateImageTaskRequest{
		ReplaceTaskID: payload.ReplaceTaskID, ConfirmUncertain: payload.ConfirmUncertain,
		ClientRequestID: payload.ClientRequestID,
		ProviderID:      payload.ProviderID,
		Mode:            service.ImageTaskModeGeneration,
		Request:         ai.ImageRequest{Prompt: payload.Prompt, Count: payload.N, Quality: payload.Quality, Size: payload.Size, Resolution: payload.Resolution, OutputFormat: payload.OutputFormat, Background: payload.Background, Options: options},
	})
	if err != nil {
		failGenerationTaskError(w, err)
		return
	}
	OK(w, task)
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	var payload imageRequest
	if err := decodeJSONBody(w, r, &payload, maxGenerationRequestBytes, true); err != nil {
		writeJSONRequestError(w, err, "图像编辑请求无效")
		return
	}
	if rejectReservedWorkflowRequestID(w, payload.ClientRequestID) {
		return
	}
	options, err := imageRequestOptionsFromJSON(payload.ProviderOptions)
	if err != nil {
		Fail(w, "供应商参数无效")
		return
	}
	task, err := service.CreateImageTask(r.Context(), service.CreateImageTaskRequest{
		ReplaceTaskID: payload.ReplaceTaskID, ConfirmUncertain: payload.ConfirmUncertain,
		ClientRequestID:   payload.ClientRequestID,
		ProviderID:        payload.ProviderID,
		Mode:              service.ImageTaskModeEdit,
		Request:           ai.ImageRequest{Prompt: payload.Prompt, Count: payload.N, Quality: payload.Quality, Size: payload.Size, Resolution: payload.Resolution, OutputFormat: payload.OutputFormat, Background: payload.Background, Options: options},
		ReferenceMediaIDs: payload.ReferenceMediaIDs,
		MaskMediaID:       payload.MaskMediaID,
	})
	if err != nil {
		failGenerationTaskError(w, err)
		return
	}
	OK(w, task)
}

func imageRequestOptionsFromJSON(raw json.RawMessage) (ai.ImageRequestOptions, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return ai.ImageRequestOptions{}, nil
	}
	var options ai.ImageRequestOptions
	if err := json.Unmarshal(raw, &options); err != nil || options == nil {
		return nil, fmt.Errorf("provider options must be an object")
	}
	return options, nil
}

func AIImageTask(w http.ResponseWriter, r *http.Request, id string) {
	task, err := service.GetImageTask(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func AIImageResume(w http.ResponseWriter, r *http.Request, id string) {
	task, err := service.ResumeImageGenerationTask(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func AIImageTaskByClientRequest(w http.ResponseWriter, r *http.Request, clientRequestID string) {
	task, err := service.GetImageTaskByClientRequest(r.Context(), clientRequestID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	var request service.CreateVideoTaskRequest
	if err := decodeJSONBody(w, r, &request, maxGenerationRequestBytes, true); err != nil {
		writeJSONRequestError(w, err, "视频请求无效")
		return
	}
	if rejectReservedWorkflowRequestID(w, request.ClientRequestID) {
		return
	}
	task, err := service.CreateVideoGenerationTask(r.Context(), request)
	if err != nil {
		failGenerationTaskError(w, err)
		return
	}
	OK(w, task)
}

func failGenerationTaskError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrGenerationRequestConflict) {
		FailStatus(w, http.StatusConflict, "客户端请求 ID 已用于不同生成请求")
		return
	}
	FailError(w, err)
}

func rejectReservedWorkflowRequestID(w http.ResponseWriter, requestID string) bool {
	if !strings.HasPrefix(strings.TrimSpace(requestID), workflowRequestIDPrefix) {
		return false
	}
	FailStatus(w, http.StatusBadRequest, "请求 ID 无效")
	return true
}

func AIVideoResume(w http.ResponseWriter, r *http.Request, id string) {
	task, err := service.ResumeVideoGenerationTask(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	result, err := service.GetVideoGenerationTask(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	task, err := service.GetVideoGenerationTask(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	if task.Status != "succeeded" || len(task.Videos) == 0 {
		Fail(w, "视频尚未完成")
		return
	}
	http.Redirect(w, r, task.Videos[0].URL, http.StatusTemporaryRedirect)
}

func AIVideoByClient(w http.ResponseWriter, r *http.Request, client string) {
	task, err := service.GetVideoGenerationTaskByClient(r.Context(), client)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}
