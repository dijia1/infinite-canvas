package handler

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/service"
)

type imageRequest struct {
	Prompt     string `json:"prompt"`
	N          int    `json:"n"`
	Quality    string `json:"quality"`
	Size       string `json:"size"`
	Resolution string `json:"resolution"`
}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	var payload imageRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	images, err := service.GenerateImages(r.Context(), ai.ImageRequest{Prompt: payload.Prompt, Count: payload.N, Quality: payload.Quality, Size: payload.Size, Resolution: payload.Resolution})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, imageResponse(images))
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		Fail(w, "图像编辑请求无效")
		return
	}
	files := r.MultipartForm.File["image"]
	references := make([]ai.ImageReference, 0, len(files))
	for _, file := range files {
		input, err := file.Open()
		if err != nil {
			Fail(w, "读取参考图失败")
			return
		}
		data, readErr := io.ReadAll(input)
		_ = input.Close()
		if readErr != nil {
			Fail(w, "读取参考图失败")
			return
		}
		references = append(references, ai.ImageReference{Name: file.Filename, ContentType: file.Header.Get("Content-Type"), Data: data})
	}
	images, err := service.EditImages(r.Context(), ai.ImageRequest{Prompt: r.FormValue("prompt"), Count: number(r.FormValue("n")), Quality: r.FormValue("quality"), Size: r.FormValue("size"), Resolution: r.FormValue("resolution")}, references)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, imageResponse(images))
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	request, err := videoRequestFromForm(r)
	if err != nil {
		Fail(w, "视频请求无效")
		return
	}
	result, err := service.CreateVideo(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
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

func imageResponse(images []ai.ImageResult) []map[string]any {
	result := make([]map[string]any, 0, len(images))
	for _, image := range images {
		if image.URL != "" {
			result = append(result, map[string]any{"url": image.URL, "mediaId": image.MediaID, "expiresAt": image.ExpiresAt, "contentType": image.ContentType})
		} else {
			result = append(result, map[string]any{"b64_json": base64.StdEncoding.EncodeToString(image.Data)})
		}
	}
	return result
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
