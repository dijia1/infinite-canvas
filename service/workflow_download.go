package service

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"log"
	"mime"
	"strings"
	"time"
	"unicode"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const WorkflowDownloadTimeout = 10 * time.Minute
const workflowImageReadTimeout = 60 * time.Second

type workflowDownloadImage struct {
	media model.Media
	name  string
}
type WorkflowImageDownload struct {
	Filename string `json:"filename"`
	Count    int    `json:"count"`
	images   []workflowDownloadImage
	store    imageStore
}

func workflowDownloadName(value string) string {
	var out []rune
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' {
			out = append(out, r)
		}
		if len(out) == 64 {
			break
		}
	}
	if len(out) == 0 {
		return "workflow"
	}
	return string(out)
}

// Resolve outputs from the immutable run graph, never from the editable definition.
func workflowDownloadOutputs(detail WorkflowRunDetail) []struct{ id, name string } {
	outputs := make(map[string]model.WorkflowOutputExecution)
	for _, output := range detail.Outputs {
		outputs[output.NodeID+"\x00"+output.SlotID] = output
	}
	var result []struct{ id, name string }
	step := 0
	for _, node := range detail.Graph.Nodes {
		if node.Type != model.WorkflowNodeImageGeneration && node.Type != model.WorkflowNodeVideoGeneration {
			continue
		}
		step++
		for i, slot := range node.Outputs {
			output := outputs[node.ID+"\x00"+slot.ID]
			if slot.Type == model.WorkflowPortImage && output.Status == "succeeded" && output.MediaID != "" {
				result = append(result, struct{ id, name string }{output.MediaID, fmt.Sprintf("%02d-%02d", step, i+1)})
			}
		}
	}
	return result
}

func PrepareWorkflowImageDownload(ctx context.Context, user PortalUser, runID string) (*WorkflowImageDownload, error) {
	detail, err := GetWorkflowRun(ctx, user, runID)
	if err != nil {
		return nil, err
	}
	outputs := workflowDownloadOutputs(detail)
	if len(outputs) == 0 {
		return nil, workflowValidationError{message: "当前运行没有可下载的成功图片"}
	}
	store, err := newImageStore()
	if err != nil {
		return nil, err
	}
	name := workflowDownloadName(detail.Run.Title)
	if detail.Run.ScopeType == model.WorkflowRunScopeFrame && detail.Run.FrameName != "" {
		name += "-" + workflowDownloadName(detail.Run.FrameName)
	}
	result := &WorkflowImageDownload{Filename: name + "-" + workflowDownloadName(detail.Run.ID) + ".zip", store: store}
	for _, output := range outputs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		item, found, err := repository.GetMedia(output.id)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, workflowValidationError{message: "生成图片已失效，无法下载"}
		}
		allowed, err := canAccessMedia(ctx, user, item)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, workflowValidationError{message: "无权下载该生成图片或图片正在清理"}
		}
		extension := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif"}[strings.ToLower(item.ContentType)]
		if extension == "" {
			return nil, workflowValidationError{message: "生成结果不是支持的图片格式"}
		}
		readCtx, cancel := context.WithTimeout(ctx, workflowImageReadTimeout)
		metadata, headErr := store.Head(readCtx, item.ObjectKey)
		cancel()
		if headErr != nil || metadata.Bytes <= 0 {
			return nil, workflowValidationError{message: "生成图片文件暂时无法读取，请稍后重试"}
		}
		// The declared length detects truncated reads before the ZIP is finalized.
		item.Bytes = metadata.Bytes
		result.images = append(result.images, workflowDownloadImage{media: item, name: output.name + extension})
	}
	result.Count = len(result.images)
	return result, nil
}

func (download *WorkflowImageDownload) Disposition() string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": download.Filename})
}

func (download *WorkflowImageDownload) Write(ctx context.Context, output io.Writer) error {
	archive := zip.NewWriter(output)
	for _, image := range download.images {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := download.writeImage(ctx, archive, image); err != nil {
			return err
		}
	}
	// A failed source must never produce a successfully finalized, incomplete ZIP.
	return archive.Close()
}

func (download *WorkflowImageDownload) writeImage(ctx context.Context, archive *zip.Writer, image workflowDownloadImage) (resultErr error) {
	defer func() {
		if resultErr != nil {
			log.Printf("workflow image download read failed media=%s error=%s", image.media.ID, taskErrorCategory(resultErr))
		}
	}()
	readCtx, cancel := context.WithTimeout(ctx, workflowImageReadTimeout)
	defer cancel()
	body, err := download.store.Get(readCtx, image.media.ObjectKey)
	if err != nil {
		return fmt.Errorf("read workflow image %s: %s", image.media.ID, taskErrorCategory(err))
	}
	// Also release the reader on cancellation for stores whose reader ignores context.
	stopClose := context.AfterFunc(readCtx, func() { _ = body.Close() })
	defer stopClose()
	defer body.Close()
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: image.name, Method: zip.Store})
	if err != nil {
		return err
	}
	written, err := io.Copy(entry, io.LimitReader(body, image.media.Bytes+1))
	if err != nil {
		return err
	}
	if err := readCtx.Err(); err != nil {
		return err
	}
	if written != image.media.Bytes {
		return fmt.Errorf("workflow image %s length changed", image.media.ID)
	}
	return nil
}
