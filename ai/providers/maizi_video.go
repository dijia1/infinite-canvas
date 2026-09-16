package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
)

const maiziVideoBaseURL = "https://www.maizitech.ai/v1"

type maiziVideoProvider struct {
	config maiziConfig
	client *http.Client
}

var maiziSeedanceVideoRequestSchema = ai.VideoRequestSchema{
	MinDuration: 4, MaxDuration: 15, DefaultDuration: 5,
	MaxReferenceImages: 9, MaxReferenceVideos: 3, MaxReferenceVideoDuration: 15,
	SupportsAudio: true,
}

func init() {
	_ = ai.Register(ai.ProviderType{ID: "maizi-video-seedance", Name: "MaiziAiVideo Seedance", Capabilities: []ai.Capability{ai.CapabilityVideoGenerate}, ConfigFields: []ai.ConfigField{
		{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
		{Key: "model", Label: "模型名称", Type: "text", Placeholder: "doubao-seedance-2.0", Required: true},
	}, VideoRequestSchema: &maiziSeedanceVideoRequestSchema, New: newMaiziVideoProvider})
}

func newMaiziVideoProvider(raw json.RawMessage) (ai.Provider, error) {
	var config maiziConfig
	if json.Unmarshal(raw, &config) != nil {
		return nil, maiziError{"视频供应商配置无效"}
	}
	config.APIKey = strings.TrimSpace(config.APIKey)
	config.Model = strings.TrimSpace(config.Model)
	if config.APIKey == "" || config.Model == "" {
		return nil, maiziError{"请填写视频供应商 API Key 和模型名称"}
	}
	return &maiziVideoProvider{config: config, client: newMaiziVideoHTTPClient()}, nil
}

func newMaiziVideoHTTPClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (p *maiziVideoProvider) CreateVideo(ctx context.Context, r ai.VideoRequest) (ai.VideoTask, error) {
	duration, err := strconv.Atoi(r.Seconds)
	if err != nil || duration < 4 || duration > 15 {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "视频时长必须为 4 至 15 秒整数"}
	}
	if strings.TrimSpace(r.Prompt) == "" || strings.TrimSpace(r.Size) == "" || strings.TrimSpace(r.Resolution) == "" {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "视频提示词、比例和分辨率不能为空"}
	}
	if len(r.ImageURLs) > 9 || len(r.VideoURLs) > 3 || len(r.References) > 0 {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "视频最多支持 9 张图片和 3 个视频，参考素材必须使用远端地址"}
	}
	for _, refs := range [][]string{r.ImageURLs, r.VideoURLs} {
		for _, ref := range refs {
			u, e := url.Parse(ref)
			if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
				return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "参考素材地址无效"}
			}
		}
	}
	payload := struct {
		Model         string   `json:"model"`
		Prompt        string   `json:"prompt"`
		Duration      int      `json:"duration"`
		Size          string   `json:"size"`
		Resolution    string   `json:"resolution"`
		GenerateAudio bool     `json:"generate_audio"`
		ImageURLs     []string `json:"image_urls,omitempty"`
		VideoURLs     []string `json:"video_urls,omitempty"`
	}{p.config.Model, r.Prompt, duration, r.Size, r.Resolution, r.GenerateAudio, r.ImageURLs, r.VideoURLs}
	body, _ := json.Marshal(payload)
	return p.request(ctx, http.MethodPost, "/videos/generations", body, true)
}
func (p *maiziVideoProvider) GetVideo(ctx context.Context, id string) (ai.VideoTask, error) {
	if strings.TrimSpace(id) == "" {
		return ai.VideoTask{}, maiziError{"视频任务 ID 不能为空"}
	}
	task, err := p.request(ctx, http.MethodGet, "/tasks/"+url.PathEscape(id), nil, false)
	if err == nil && task.ID != id {
		return ai.VideoTask{}, maiziError{"视频供应商返回不匹配的任务 ID"}
	}
	return task, err
}

// Result media is streamed into managed storage by the task worker.
func (p *maiziVideoProvider) GetVideoContent(context.Context, string) (ai.VideoContent, error) {
	return ai.VideoContent{}, maiziError{"请通过已保存的视频媒体下载结果"}
}

func (p *maiziVideoProvider) request(ctx context.Context, method, path string, body []byte, create bool) (ai.VideoTask, error) {
	fail := func(message string, uncertain bool) (ai.VideoTask, error) {
		if create {
			return ai.VideoTask{}, &ai.VideoSubmissionError{Message: message, Uncertain: uncertain}
		}
		return ai.VideoTask{}, maiziError{message}
	}
	req, err := http.NewRequestWithContext(ctx, method, maiziVideoBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return fail("无法创建视频请求", false)
	}
	req.Header.Set("Authorization", "Bearer "+p.config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return fail("视频供应商请求失败，提交结果可能不确定", true)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fail(fmt.Sprintf("视频供应商返回 HTTP %d", resp.StatusCode), resp.StatusCode >= 500 || resp.StatusCode == 408)
	}
	const limit = 1 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || len(data) > limit {
		return fail("视频供应商响应读取失败", true)
	}
	var wire struct {
		ID         string          `json:"id"`
		Status     string          `json:"status"`
		Progress   int             `json:"progress"`
		ResultURLs []string        `json:"result_urls"`
		Cost       json.RawMessage `json:"cost"`
		Currency   string          `json:"currency"`
		Error      string          `json:"error_msg"`
	}
	if json.Unmarshal(data, &wire) != nil || strings.TrimSpace(wire.ID) == "" {
		return fail("视频供应商返回无效任务响应", true)
	}
	switch wire.Status {
	case "pending", "queued", "processing", "running", "completed", "failed", "cancelled", "canceled":
	default:
		return fail("视频供应商返回未知任务状态", true)
	}
	if wire.Status == "completed" && len(wire.ResultURLs) == 0 {
		return fail("视频供应商返回空视频结果", false)
	}
	for _, raw := range wire.ResultURLs {
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return fail("视频供应商返回无效视频地址", false)
		}
	}
	cost := ""
	if len(wire.Cost) > 0 && string(wire.Cost) != "null" {
		if json.Unmarshal(wire.Cost, &cost) != nil {
			var n json.Number
			if json.Unmarshal(wire.Cost, &n) != nil {
				return fail("视频供应商费用响应无效", true)
			}
			cost = n.String()
		}
	}
	if wire.Progress < 0 {
		wire.Progress = 0
	}
	if wire.Progress > 100 {
		wire.Progress = 100
	}
	safeError := ""
	if wire.Error != "" {
		safeError = "视频供应商生成失败"
	}
	return ai.VideoTask{ID: wire.ID, Status: wire.Status, Progress: wire.Progress, ResultURLs: wire.ResultURLs, Cost: cost, Currency: wire.Currency, Error: safeError}, nil
}

var _ ai.VideoGenerator = (*maiziVideoProvider)(nil)
var _ error = (*ai.VideoSubmissionError)(nil)
