package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/service"
)

type imageRequest struct {
	ClientRequestID string `json:"clientRequestId"`
	Prompt          string `json:"prompt"`
	N               int    `json:"n"`
	Quality         string `json:"quality"`
	Size            string `json:"size"`
	Resolution      string `json:"resolution"`
	OutputFormat    string `json:"output_format"`
	Background      string `json:"background"`
}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	var payload imageRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "图片生成请求无效")
		return
	}
	task, err := service.CreateImageTask(r.Context(), service.CreateImageTaskRequest{
		ClientRequestID: payload.ClientRequestID,
		Mode:            service.ImageTaskModeGeneration,
		Request:         ai.ImageRequest{Prompt: payload.Prompt, Count: payload.N, Quality: payload.Quality, Size: payload.Size, Resolution: payload.Resolution, OutputFormat: payload.OutputFormat, Background: payload.Background},
	})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		Fail(w, "图像编辑请求无效")
		return
	}
	files := r.MultipartForm.File["image"]
	references := make([]ai.ImageReference, 0, len(files))
	totalBytes := int64(0)
	for _, file := range files {
		input, err := file.Open()
		if err != nil {
			Fail(w, "读取参考图失败")
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(input, 50<<20+1))
		_ = input.Close()
		if readErr != nil || len(data) > 50<<20 {
			Fail(w, "读取参考图失败")
			return
		}
		totalBytes += int64(len(data))
		if totalBytes > 50<<20 {
			Fail(w, "参考图总大小无效")
			return
		}
		references = append(references, ai.ImageReference{Name: file.Filename, ContentType: file.Header.Get("Content-Type"), Data: data})
	}
	mask, err := imageMaskFromForm(r)
	if err != nil {
		Fail(w, "遮罩文件无效")
		return
	}
	task, err := service.CreateImageTask(r.Context(), service.CreateImageTaskRequest{
		ClientRequestID: r.FormValue("clientRequestId"),
		Mode:            service.ImageTaskModeEdit,
		Request:         ai.ImageRequest{Prompt: r.FormValue("prompt"), Count: number(r.FormValue("n")), Quality: r.FormValue("quality"), Size: r.FormValue("size"), Resolution: r.FormValue("resolution"), OutputFormat: r.FormValue("output_format"), Background: r.FormValue("background")},
		References:      references,
		Mask:            mask,
	})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, task)
}

func imageMaskFromForm(r *http.Request) (*ai.ImageReference, error) {
	files := r.MultipartForm.File["mask"]
	if len(files) == 0 {
		return nil, nil
	}
	if len(files) != 1 {
		return nil, fmt.Errorf("multiple masks")
	}
	file := files[0]
	input, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, 50<<20+1))
	if err != nil || len(data) > 50<<20 {
		return nil, err
	}
	return &ai.ImageReference{Name: file.Filename, ContentType: file.Header.Get("Content-Type"), Data: data}, nil
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
	request, err := videoRequestFromForm(r)
	if err != nil {
		Fail(w, "视频请求无效")
		return
	}
	result, err := service.CreateVideo(r.Context(), request)
	if err != nil {
		service.RecordOperation(r.Context(), service.OperationLogInput{Action: "video_generate", Status: "failure", TargetType: "video_task", Prompt: request.Prompt, ErrorMessage: service.AuditErrorSummary(err, "视频生成失败")})
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "video_generate", TargetType: "video_task", TargetID: result.ID, Prompt: request.Prompt})
	OK(w, result)
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	result, err := service.GetVideo(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	result, err := service.GetVideoContent(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	if result.ContentType != "" {
		w.Header().Set("Content-Type", result.ContentType)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Data)
}

func videoRequestFromForm(r *http.Request) (ai.VideoRequest, error) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return ai.VideoRequest{}, err
	}
	files := r.MultipartForm.File["input_reference[]"]
	references := make([]ai.ImageReference, 0, len(files))
	for _, file := range files {
		input, err := file.Open()
		if err != nil {
			return ai.VideoRequest{}, err
		}
		data, readErr := io.ReadAll(input)
		_ = input.Close()
		if readErr != nil {
			return ai.VideoRequest{}, readErr
		}
		references = append(references, ai.ImageReference{Name: file.Filename, ContentType: file.Header.Get("Content-Type"), Data: data})
	}
	return ai.VideoRequest{Prompt: r.FormValue("prompt"), Seconds: r.FormValue("seconds"), Size: r.FormValue("size"), Resolution: r.FormValue("resolution_name"), References: references}, nil
}

func number(value string) int {
	var result int
	_, _ = fmt.Sscan(value, &result)
	if result < 1 {
		return 1
	}
	return result
}
