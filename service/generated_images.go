package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
)

var generatedImageClient = &http.Client{Timeout: 30 * time.Second}

// persistGeneratedImages makes provider results private media records. It never
// writes a provider image to the application's public filesystem.
func persistGeneratedImages(ctx context.Context, images []ai.ImageResult) ([]ai.ImageResult, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok {
		return nil, errors.New("未经过 Portal Gateway 身份验证")
	}
	result := make([]ai.ImageResult, 0, len(images))
	for _, image := range images {
		data, contentType := image.Data, image.ContentType
		filename := "generated.png"
		if len(data) == 0 {
			if image.URL == "" {
				return nil, errors.New("生成图片内容为空")
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, image.URL, nil)
			if err != nil {
				return nil, fmt.Errorf("下载生成图片失败: %w", err)
			}
			response, err := generatedImageClient.Do(request)
			if err != nil {
				return nil, fmt.Errorf("下载生成图片失败: %w", err)
			}
			data, err = io.ReadAll(io.LimitReader(response.Body, maxMediaBytes+1))
			contentType = response.Header.Get("Content-Type")
			_ = response.Body.Close()
			if err != nil || response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices || len(data) > maxMediaBytes {
				return nil, errors.New("下载生成图片失败")
			}
			filename = filepath.Base(strings.Split(image.URL, "?")[0])
		}
		access, err := saveImage(ctx, user, model.MediaSourceGenerated, filename, contentType, data, false)
		if err != nil {
			return nil, err
		}
		result = append(result, ai.ImageResult{URL: access.URL, MediaID: access.MediaID, ExpiresAt: access.ExpiresAt, ContentType: access.ContentType})
	}
	return result, nil
}
