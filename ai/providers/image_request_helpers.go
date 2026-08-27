package providers

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
)

func cloneImageRequestOptions(input ai.ImageRequestOptions) ai.ImageRequestOptions {
	result := make(ai.ImageRequestOptions, len(input))
	for key, value := range input {
		result[key] = append(json.RawMessage(nil), value...)
	}
	return result
}

func imageRequestOptionString(options ai.ImageRequestOptions, key string) string {
	var value string
	_ = json.Unmarshal(options[key], &value)
	return value
}

func marshalRedactedJSON(body map[string]any) (json.RawMessage, error) {
	var result bytes.Buffer
	encoder := json.NewEncoder(&result)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(redactImageDataURLs(body)); err != nil {
		return nil, err
	}
	return json.RawMessage(bytes.TrimSpace(result.Bytes())), nil
}

func redactImageDataURLs(value any) any {
	switch value := value.(type) {
	case string:
		return redactImageDataURL(value)
	case []string:
		result := make([]string, len(value))
		for index, item := range value {
			result[index] = redactImageDataURL(item)
		}
		return result
	case []any:
		result := make([]any, len(value))
		for index, item := range value {
			result[index] = redactImageDataURLs(item)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, item := range value {
			result[key] = redactImageDataURLs(item)
		}
		return result
	default:
		return value
	}
}

func redactImageDataURL(value string) string {
	lowercase := strings.ToLower(value)
	if !strings.HasPrefix(lowercase, "data:image/") {
		return value
	}
	if delimiter := strings.Index(lowercase, ";base64,"); delimiter >= 0 {
		return value[:delimiter+len(";base64,")] + "<base64>"
	}
	return value
}
