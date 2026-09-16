package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const videoPollInterval = 12 * time.Second

func videoTaskTimeout() (time.Duration, error) {
	value := strings.TrimSpace(config.Cfg.AIVideoTaskTimeout)
	if value == "" {
		return 30 * time.Minute, nil
	}
	d, err := time.ParseDuration(value)
	if err != nil || d <= 0 {
		return 0, errors.New("AI_VIDEO_TASK_TIMEOUT 必须是正时长")
	}
	return d, nil
}
func StartVideoTaskWorker(parent context.Context) (func(), error) {
	if _, err := videoTaskTimeout(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				item, found, err := repository.ClaimNextVideoGenerationTask(time.Now().UTC())
				if err != nil {
					log.Printf("video task claim failed: %v", err)
				}
				if found && err == nil {
					stepCtx, stop := context.WithTimeout(ctx, 90*time.Second)
					err = processVideoTaskStep(stepCtx, item, time.Now().UTC())
					stop()
					if err != nil {
						log.Printf("video task step failed id=%s: %v", item.ID, err)
					}
					continue
				}
				if !waitForImageTask(ctx, time.Second) {
					return
				}
			}
		}()
	}
	return func() { cancel(); wg.Wait() }, nil
}
func processVideoTaskStep(ctx context.Context, item model.VideoGenerationTask, current time.Time) error {
	release := func(updates map[string]any) error {
		updates["lease_until"] = nil
		updates["next_poll_at"] = current.Add(videoPollInterval)
		return repository.UpdateClaimedVideoTask(item, updates)
	}
	// Submission ambiguity takes precedence over an elapsed waiting deadline.
	if item.Status == "submitting" && item.ProviderTaskID == "" {
		return release(map[string]any{"status": "uncertain", "error": "提交结果不确定，请核对供应商任务，系统不会自动重复生成"})
	}
	if !current.Before(item.Deadline) {
		if item.Status == "queued" {
			return failVideoTask(item, "排队超时，尚未提交供应商")
		}
		return release(map[string]any{"status": "paused", "error": "等待超时，可继续检查原任务"})
	}
	providerType, ok := ai.Type(item.ProviderType)
	if !ok {
		return failVideoTask(item, "视频供应商不存在")
	}
	raw, err := providerType.New(json.RawMessage(item.ProviderConfig))
	if err != nil {
		return failVideoTask(item, "视频供应商配置无效")
	}
	provider, ok := raw.(ai.VideoGenerator)
	if !ok {
		return failVideoTask(item, "供应商不支持视频")
	}
	if item.Status == "queued" {
		var request CreateVideoTaskRequest
		if json.Unmarshal([]byte(item.RequestJSON), &request) != nil {
			return failVideoTask(item, "视频任务参数损坏")
		}
		upstream, err := resolveVideoTaskInputs(ctx, PortalUser{UID: item.OwnerUID}, request)
		if err != nil {
			return failVideoTask(item, AuditErrorSummary(err, "参考素材不可用"))
		}
		if err := repository.UpdateClaimedVideoTask(item, map[string]any{"status": "submitting"}); err != nil {
			return err
		}
		task, err := provider.CreateVideo(ctx, upstream)
		if err != nil {
			var rejection *ai.VideoSubmissionError
			if errors.As(err, &rejection) && !rejection.Uncertain {
				return failVideoTask(item, AuditErrorSummary(err, "视频提交失败"))
			}
			return release(map[string]any{"status": "uncertain", "error": "提交结果不确定，请核对供应商任务，系统不会自动重复生成"})
		}
		if strings.TrimSpace(task.ID) == "" {
			return release(map[string]any{"status": "uncertain", "error": "供应商未返回任务 ID，请核对任务"})
		}
		return release(map[string]any{"status": "running", "provider_task_id": task.ID, "attempts": 0})
	}
	if item.Status == "running" {
		task, err := provider.GetVideo(ctx, item.ProviderTaskID)
		if err != nil {
			return retryVideoTask(item, current, "查询视频任务失败")
		}
		switch task.Status {
		case "failed", "cancelled", "canceled":
			return failVideoTask(item, task.Error)
		case "completed", "succeeded":
			if len(task.ResultURLs) == 0 || len(task.ResultURLs) > 4 {
				return retryVideoTask(item, current, "供应商返回的视频结果无效")
			}
			urls, _ := json.Marshal(task.ResultURLs)
			return release(map[string]any{"status": "saving", "result_urls_json": string(urls), "upstream_cost": task.Cost, "upstream_currency": task.Currency, "attempts": 0})
		case "processing", "running", "queued", "pending", "submitted":
			progress := task.Progress
			if progress < 0 {
				progress = 0
			}
			if progress > 99 {
				progress = 99
			}
			return release(map[string]any{"progress": progress, "attempts": 0})
		default:
			return retryVideoTask(item, current, "供应商返回未知任务状态")
		}
	}
	if item.Status == "saving" {
		media, err := saveVideoTaskResults(ctx, item)
		if err != nil {
			return retryVideoTask(item, current, "视频保存失败，可继续检查原任务")
		}
		// Reserved outputs survive ambiguous commits; never delete on DB error.
		if err := repository.CompleteVideoGenerationTask(item, media); err != nil {
			return err
		}
		return nil
	}
	return fmt.Errorf("unexpected video task state %s", item.Status)
}
func retryVideoTask(item model.VideoGenerationTask, current time.Time, message string) error {
	status := item.Status
	attempts := item.Attempts + 1
	if attempts >= 5 {
		status = "paused"
		message += "，请继续检查"
	}
	return repository.UpdateClaimedVideoTask(item, map[string]any{"status": status, "attempts": attempts, "error": message, "lease_until": nil, "next_poll_at": current.Add(videoPollInterval * time.Duration(attempts))})
}
func failVideoTask(item model.VideoGenerationTask, message string) error {
	if message == "" {
		message = "视频生成失败"
	}
	current := time.Now().UTC()
	return repository.FinishFailedVideoTask(item, message, current)
}

var videoDownloadClient = &http.Client{Timeout: 75 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, entry := range ips {
		ip := entry.IP
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			return nil, errors.New("视频结果地址不可访问")
		}
	}
	if len(ips) == 0 {
		return nil, errors.New("视频结果地址无法解析")
	}
	return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
}}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 || req.URL.Scheme != "https" {
		return errors.New("视频重定向无效")
	}
	return nil
}}

func saveVideoTaskResults(ctx context.Context, item model.VideoGenerationTask) (result []model.Media, err error) {
	var urls []string
	if err = json.Unmarshal([]byte(item.ResultURLsJSON), &urls); err != nil {
		return nil, err
	}
	var outputs []videoOutputReservation
	if item.PendingOutputsJSON != "" {
		if err := json.Unmarshal([]byte(item.PendingOutputsJSON), &outputs); err != nil {
			return nil, err
		}
	}
	if len(outputs) == 0 {
		for range urls {
			outputs = append(outputs, videoOutputReservation{ID: newID("media"), ObjectKey: privateImageObjectKey(item.OwnerUID, model.MediaSourceGenerated, "mp4", time.Now().UTC())})
		}
		encoded, _ := json.Marshal(outputs)
		if err := repository.UpdateClaimedVideoTask(item, map[string]any{"pending_outputs_json": string(encoded)}); err != nil {
			return nil, err
		}
	}
	if len(outputs) != len(urls) {
		return nil, errors.New("视频输出记录不一致")
	}
	store, err := newImageStore()
	if err != nil {
		return nil, err
	}
	for index, address := range urls {
		// OSS may already contain this reserved result after a lost DB commit
		// or process exit. Recover it without depending on an expired CDN URL.
		if _, headErr := store.Head(ctx, outputs[index].ObjectKey); headErr == nil {
			reader, e := store.Get(ctx, outputs[index].ObjectKey)
			if e != nil {
				return result, e
			}
			file, e := spoolVideo(reader)
			reader.Close()
			if e != nil {
				return result, e
			}
			media, e := persistGeneratedVideoFile(ctx, store, item, outputs[index], file, false)
			file.Close()
			os.Remove(file.Name())
			if e != nil {
				return result, e
			}
			result = append(result, media)
			continue
		} else if !isMissingImageObjectError(headErr) {
			return result, headErr
		}
		parsed, e := url.Parse(address)
		if e != nil || parsed.Scheme != "https" || parsed.User != nil {
			return result, errors.New("视频结果 URL 无效")
		}
		request, e := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		if e != nil {
			return result, e
		}
		response, e := videoDownloadClient.Do(request)
		if e != nil {
			return result, errors.New("视频结果下载失败")
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return result, errors.New("视频结果下载失败")
		}
		file, e := spoolVideo(response.Body)
		response.Body.Close()
		if e != nil {
			return result, e
		}
		m, e := persistGeneratedVideoFile(ctx, store, item, outputs[index], file, true)
		file.Close()
		os.Remove(file.Name())
		if e != nil {
			return result, e
		}
		result = append(result, m)
	}
	if len(result) == 0 {
		return nil, errors.New("视频结果为空")
	}
	return result, nil
}

type videoOutputReservation struct {
	ID        string `json:"id"`
	ObjectKey string `json:"objectKey"`
}

func persistGeneratedVideoFile(ctx context.Context, store imageStore, item model.VideoGenerationTask, output videoOutputReservation, file *os.File, upload bool) (model.Media, error) {
	duration, width, height, err := probeVideoFile(ctx, file.Name())
	if err != nil {
		return model.Media{}, err
	}
	info, err := file.Stat()
	if err != nil {
		return model.Media{}, err
	}
	current := time.Now().UTC()
	expiry := current.Add(24 * time.Hour)
	media := model.Media{ID: output.ID, OwnerUID: item.OwnerUID, Source: model.MediaSourceGenerated, ObjectKey: output.ObjectKey, ContentType: "video/mp4", Bytes: info.Size(), Width: width, Height: height, Duration: duration, Filename: "generated-video.mp4", Title: "生成视频", CreatedAt: current.Format(time.RFC3339), ExpiresAt: &expiry, CleanupStatus: model.MediaCleanupActive}
	if upload {
		if err := putVideoFile(ctx, store, media.ObjectKey, file); err != nil {
			return model.Media{}, err
		}
	}
	metadata, err := store.Head(ctx, media.ObjectKey)
	if err != nil {
		return model.Media{}, err
	}
	media.ObjectVersionID, media.ObjectETag = metadata.VersionID, metadata.ETag
	return media, nil
}
