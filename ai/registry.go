package ai

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

type Capability string

const (
	CapabilityImageGenerate Capability = "image_generate"
	CapabilityImageEdit     Capability = "image_edit"
	CapabilityVideoGenerate Capability = "video_generate"
)

type Provider interface{}

type ConfigField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Type        string `json:"type"`
	Placeholder string `json:"placeholder,omitempty"`
	Required    bool   `json:"required"`
}

type ProviderType struct {
	ID           string                                  `json:"id"`
	Name         string                                  `json:"name"`
	Capabilities []Capability                            `json:"capabilities"`
	ConfigFields []ConfigField                           `json:"configFields"`
	New          func(json.RawMessage) (Provider, error) `json:"-"`
}

func (item ProviderType) Supports(capability Capability) bool {
	for _, value := range item.Capabilities {
		if value == capability {
			return true
		}
	}
	return false
}

type Registry struct {
	mu    sync.RWMutex
	types map[string]ProviderType
}

func NewRegistry() *Registry {
	return &Registry{types: map[string]ProviderType{}}
}

func (registry *Registry) Register(item ProviderType) error {
	item.ID = strings.TrimSpace(item.ID)
	item.Name = strings.TrimSpace(item.Name)
	if item.ID == "" || item.Name == "" || len(item.Capabilities) == 0 {
		return errors.New("供应商类型配置不完整")
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.types[item.ID]; exists {
		return errors.New("供应商类型已注册")
	}
	registry.types[item.ID] = item
	return nil
}

func (registry *Registry) Types() []ProviderType {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	result := make([]ProviderType, 0, len(registry.types))
	for _, item := range registry.types {
		item.New = nil
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (registry *Registry) Type(id string) (ProviderType, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	item, ok := registry.types[id]
	return item, ok
}

var providers = NewRegistry()

func Register(item ProviderType) error    { return providers.Register(item) }
func Types() []ProviderType               { return providers.Types() }
func Type(id string) (ProviderType, bool) { return providers.Type(id) }

type ImageRequest struct {
	Prompt       string
	Count        int
	Quality      string
	Size         string
	Resolution   string
	OutputFormat string
	Background   string
}

type ImageReference struct {
	Name        string
	ContentType string
	Data        []byte
}

type ImageResult struct {
	Data        []byte
	ContentType string
	URL         string
	MediaID     string
	ExpiresAt   time.Time
}

type ImageGenerator interface {
	GenerateImage(context.Context, ImageRequest) ([]ImageResult, error)
}

type ImageEditor interface {
	EditImage(context.Context, ImageRequest, []ImageReference) ([]ImageResult, error)
}

type ImageTaskRequest struct {
	Request    ImageRequest
	References []ImageReference
	Mask       *ImageReference
}

type ImageTask struct {
	ID         string
	Status     string
	Progress   int
	ResultURLs []string
	Error      string
}

type ImageTaskProvider interface {
	CreateImageTask(context.Context, ImageTaskRequest) (ImageTask, error)
	GetImageTask(context.Context, string) (ImageTask, error)
}

// ImageTaskRequestSummary is a redacted, provider-specific audit snapshot.
// It must never contain credentials, signed URLs, or image bytes.
type ImageTaskRequestSummary struct {
	Method          string                         `json:"method"`
	Endpoint        string                         `json:"endpoint"`
	ContentType     string                         `json:"contentType"`
	JSONBody        json.RawMessage                `json:"jsonBody,omitempty"`
	MultipartFields []ImageTaskRequestSummaryField `json:"multipartFields,omitempty"`
}

type ImageTaskRequestSummaryField struct {
	Name        string `json:"name"`
	Value       string `json:"value,omitempty"`
	Filename    string `json:"filename,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Bytes       int    `json:"bytes,omitempty"`
}

// ImageTaskRequestSummarizer is required for async image providers so every
// outbound image request has an auditable, redacted request snapshot.
type ImageTaskRequestSummarizer interface {
	SummarizeImageTaskRequest(ImageTaskRequest) (ImageTaskRequestSummary, error)
}

type VideoRequest struct {
	Prompt     string
	Seconds    string
	Size       string
	Resolution string
	References []ImageReference
}

type VideoTask struct {
	ID     string `json:"id"`
	Status string `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

type VideoContent struct {
	Data        []byte
	ContentType string
}

type VideoGenerator interface {
	CreateVideo(context.Context, VideoRequest) (VideoTask, error)
	GetVideo(context.Context, string) (VideoTask, error)
	GetVideoContent(context.Context, string) (VideoContent, error)
}
