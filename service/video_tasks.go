package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
)

func CreateVideo(ctx context.Context, request ai.VideoRequest) (ai.VideoTask, error) {
	provider, providerID, err := resolveProviderAndID(ai.CapabilityVideoGenerate, request.ProviderID)
	if err != nil {
		return ai.VideoTask{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoTask{}, errors.New("当前生视频供应商未实现")
	}
	task, err := generator.CreateVideo(ctx, request)
	if err != nil {
		return ai.VideoTask{}, err
	}
	task.ID = encodeVideoTaskID(providerID, task.ID)
	return task, nil
}

func GetVideo(ctx context.Context, id string) (ai.VideoTask, error) {
	providerID, upstreamID, encoded := decodeVideoTaskID(id)
	if !encoded {
		upstreamID = id
	}
	provider, err := resolveProviderForID(ai.CapabilityVideoGenerate, providerID)
	if err != nil {
		return ai.VideoTask{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoTask{}, errors.New("当前生视频供应商未实现")
	}
	task, err := generator.GetVideo(ctx, upstreamID)
	if err != nil {
		return ai.VideoTask{}, err
	}
	task.ID = id
	return task, nil
}

func GetVideoContent(ctx context.Context, id string) (ai.VideoContent, error) {
	providerID, upstreamID, encoded := decodeVideoTaskID(id)
	if !encoded {
		upstreamID = id
	}
	provider, err := resolveProviderForID(ai.CapabilityVideoGenerate, providerID)
	if err != nil {
		return ai.VideoContent{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoContent{}, errors.New("当前生视频供应商未实现")
	}
	return generator.GetVideoContent(ctx, upstreamID)
}

const videoTaskIDPrefix = "provider:"

func encodeVideoTaskID(providerID, upstreamID string) string {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" || strings.TrimSpace(upstreamID) == "" {
		return upstreamID
	}
	payload, _ := json.Marshal([2]string{providerID, upstreamID})
	return videoTaskIDPrefix + base64.RawURLEncoding.EncodeToString(payload)
}

func decodeVideoTaskID(id string) (providerID, upstreamID string, ok bool) {
	if !strings.HasPrefix(id, videoTaskIDPrefix) {
		return "", "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(id, videoTaskIDPrefix))
	if err != nil {
		return "", "", false
	}
	var values [2]string
	if err := json.Unmarshal(payload, &values); err != nil || strings.TrimSpace(values[0]) == "" || strings.TrimSpace(values[1]) == "" {
		return "", "", false
	}
	return values[0], values[1], true
}
