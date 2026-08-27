package ai

import (
	"encoding/json"
	"fmt"
	"strings"
)

type ImageRequestFieldType string

const (
	ImageRequestFieldSelect  ImageRequestFieldType = "select"
	ImageRequestFieldBoolean ImageRequestFieldType = "boolean"
	ImageRequestFieldText    ImageRequestFieldType = "text"
	ImageRequestFieldNumber  ImageRequestFieldType = "number"
)

// ImageRequestOptions stores safe, provider-declared values independently
// from the common image request fields.
type ImageRequestOptions map[string]json.RawMessage

type ImageRequestFieldOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type ImageRequestField struct {
	Key         string                    `json:"key"`
	Label       string                    `json:"label"`
	Type        ImageRequestFieldType     `json:"type"`
	Description string                    `json:"description,omitempty"`
	Required    bool                      `json:"required"`
	Default     json.RawMessage           `json:"default,omitempty"`
	Options     []ImageRequestFieldOption `json:"options,omitempty"`
}

// ImageRequestSchema is public metadata for the active provider. It never
// includes provider configuration or native endpoint details.
type ImageRequestSchema struct {
	Version            string              `json:"version"`
	Fields             []ImageRequestField `json:"fields"`
	MaxReferenceImages int                 `json:"maxReferenceImages"`
	SupportsMask       bool                `json:"supportsMask"`
}

func NormalizeImageRequestOptions(schema ImageRequestSchema, input ImageRequestOptions) (ImageRequestOptions, error) {
	fields := make(map[string]ImageRequestField, len(schema.Fields))
	for _, field := range schema.Fields {
		field.Key = strings.TrimSpace(field.Key)
		if field.Key == "" {
			return nil, fmt.Errorf("图片参数 Schema 包含空字段")
		}
		if _, exists := fields[field.Key]; exists {
			return nil, fmt.Errorf("图片参数 Schema 包含重复字段：%s", field.Key)
		}
		fields[field.Key] = field
	}

	result := make(ImageRequestOptions, len(fields))
	for key, raw := range input {
		field, exists := fields[key]
		if !exists {
			return nil, fmt.Errorf("当前供应商不支持参数：%s", key)
		}
		if err := validateImageRequestOption(field, raw); err != nil {
			return nil, err
		}
		result[key] = append(json.RawMessage(nil), raw...)
	}
	for key, field := range fields {
		if _, exists := result[key]; exists {
			continue
		}
		if len(field.Default) > 0 {
			if err := validateImageRequestOption(field, field.Default); err != nil {
				return nil, err
			}
			result[key] = append(json.RawMessage(nil), field.Default...)
			continue
		}
		if field.Required {
			return nil, fmt.Errorf("请填写参数：%s", field.Label)
		}
	}
	return result, nil
}

func validateImageRequestOption(field ImageRequestField, raw json.RawMessage) error {
	if !json.Valid(raw) {
		return fmt.Errorf("参数 %s 格式无效", field.Label)
	}
	switch field.Type {
	case ImageRequestFieldSelect:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("参数 %s 必须是选项", field.Label)
		}
		for _, option := range field.Options {
			if value == option.Value {
				return nil
			}
		}
		return fmt.Errorf("参数 %s 不支持值 %s", field.Label, value)
	case ImageRequestFieldBoolean:
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("参数 %s 必须是布尔值", field.Label)
		}
	case ImageRequestFieldText:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("参数 %s 必须是文本", field.Label)
		}
	case ImageRequestFieldNumber:
		var value float64
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("参数 %s 必须是数字", field.Label)
		}
	default:
		return fmt.Errorf("参数 %s 类型无效", field.Label)
	}
	return nil
}
