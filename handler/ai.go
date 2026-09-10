package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/service"
)

const maxMultipartImageBytes int64 = 50 << 20
const multipartRequestOverheadBytes int64 = 1 << 20
const maxImageEditRequestBytes int64 = maxMultipartImageBytes*2 + multipartRequestOverheadBytes
const workflowRequestIDPrefix = "workflow-"

type imageRequest struct {
	ClientRequestID string          `json:"clientRequestId"`
	ProviderID      string          `json:"providerId"`
	Prompt          string          `json:"prompt"`
	N               int             `json:"n"`
	Quality         string          `json:"quality"`
	Size            string          `json:"size"`
	Resolution      string          `json:"resolution"`
	OutputFormat    string          `json:"output_format"`
	Background      string          `json:"background"`
	ProviderOptions json.RawMessage `json:"providerOptions"`
}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	var payload imageRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "图片生成请求无效")
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
		ClientRequestID: payload.ClientRequestID,
		ProviderID:      payload.ProviderID,
		Mode:            service.ImageTaskModeGeneration,
		Request:         ai.ImageRequest{Prompt: payload.Prompt, Count: payload.N, Quality: payload.Quality, Size: payload.Size, Resolution: payload.Resolution, OutputFormat: payload.OutputFormat, Background: payload.Background, Options: options},
	})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	limitMultipartRequestBody(w, r, maxImageEditRequestBytes)
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		Fail(w, "图像编辑请求无效")
		return
	}
	if rejectReservedWorkflowRequestID(w, r.FormValue("clientRequestId")) {
		return
	}
	references, err := readMultipartImageReferences(r.MultipartForm.File["image"], maxMultipartImageBytes)
	if err != nil {
		Fail(w, "参考图总大小无效")
		return
	}
	mask, err := imageMaskFromForm(r)
	if err != nil {
		Fail(w, "遮罩文件无效")
		return
	}
	options, err := imageRequestOptionsFromForm(r.FormValue("providerOptions"))
	if err != nil {
		Fail(w, "供应商参数无效")
		return
	}
	task, err := service.CreateImageTask(r.Context(), service.CreateImageTaskRequest{
		ClientRequestID:   r.FormValue("clientRequestId"),
		ProviderID:        r.FormValue("providerId"),
		Mode:              service.ImageTaskModeEdit,
		Request:           ai.ImageRequest{Prompt: r.FormValue("prompt"), Count: number(r.FormValue("n")), Quality: r.FormValue("quality"), Size: r.FormValue("size"), Resolution: r.FormValue("resolution"), OutputFormat: r.FormValue("output_format"), Background: r.FormValue("background"), Options: options},
		References:        references,
		ReferenceMediaIDs: r.MultipartForm.Value["referenceMediaId"],
		Mask:              mask,
	})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func imageRequestOptionsFromForm(value string) (ai.ImageRequestOptions, error) {
	if value == "" {
		return ai.ImageRequestOptions{}, nil
	}
	return imageRequestOptionsFromJSON(json.RawMessage(value))
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

func imageMaskFromForm(r *http.Request) (*ai.ImageReference, error) {
	files := r.MultipartForm.File["mask"]
	if len(files) == 0 {
		return nil, nil
	}
	if len(files) != 1 {
		return nil, fmt.Errorf("multiple masks")
	}
	reference, err := readMultipartImageReference(files[0])
	if err != nil {
		return nil, err
	}
	return &reference, nil
}

func AIImageTask(w http.ResponseWriter, r *http.Request, id string) {
	task, err := service.GetImageTask(r.Context(), id)
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var request service.CreateVideoTaskRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		Fail(w, "视频请求无效")
		return
	}
	if rejectReservedWorkflowRequestID(w, request.ClientRequestID) {
		return
	}
	task, err := service.CreateVideoGenerationTask(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
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

func limitMultipartRequestBody(w http.ResponseWriter, r *http.Request, maxBytes int64) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
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

func readMultipartImageReferences(files []*multipart.FileHeader, maxTotalBytes int64) ([]ai.ImageReference, error) {
	references := make([]ai.ImageReference, 0, len(files))
	totalBytes := int64(0)
	for _, file := range files {
		reference, err := readMultipartImageReference(file)
		if err != nil {
			return nil, err
		}
		totalBytes += int64(len(reference.Data))
		if totalBytes > maxTotalBytes {
			return nil, fmt.Errorf("reference images exceed total size limit")
		}
		references = append(references, reference)
	}
	return references, nil
}

func readMultipartImageReference(file *multipart.FileHeader) (ai.ImageReference, error) {
	input, err := file.Open()
	if err != nil {
		return ai.ImageReference{}, err
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, maxMultipartImageBytes+1))
	if err != nil {
		return ai.ImageReference{}, err
	}
	if int64(len(data)) > maxMultipartImageBytes {
		return ai.ImageReference{}, fmt.Errorf("reference image exceeds size limit")
	}
	return ai.ImageReference{Name: file.Filename, ContentType: file.Header.Get("Content-Type"), Data: data}, nil
}

func number(value string) int {
	var result int
	_, _ = fmt.Sscan(value, &result)
	if result < 1 {
		return 1
	}
	return result
}

func AIVideoByClient(w http.ResponseWriter, r *http.Request, client string) {
	task, err := service.GetVideoGenerationTaskByClient(r.Context(), client)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}
