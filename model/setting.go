package model

import (
	"encoding/json"

	"github.com/shopspring/decimal"
)

type SettingKey string

const (
	SettingKeyAI SettingKey = "ai"
)

type AIProvider struct {
	ID              string                 `json:"id"`
	Name            string                 `json:"name"`
	Type            string                 `json:"type"`
	Enabled         bool                   `json:"enabled"`
	VideoPrices     []ImageResolutionPrice `json:"videoPrices"`
	AspectRatios    []string               `json:"aspectRatios"`
	ImagePrices     []ImageResolutionPrice `json:"imagePrices"`
	ImageCallAmount decimal.Decimal        `json:"imageCallAmount"`
	Config          json.RawMessage        `json:"config"`
}

type ImageResolutionPrice struct {
	Resolution string          `json:"resolution"`
	Amount     decimal.Decimal `json:"amount"`
}

type AISettings struct {
	Providers       []AIProvider `json:"providers"`
	ImageProviderID string       `json:"imageProviderId"`
	VideoProviderID string       `json:"videoProviderId"`
}

// Setting 系统配置。
type Setting struct {
	Key       SettingKey      `json:"key" gorm:"primaryKey"`
	Value     json.RawMessage `json:"value" gorm:"serializer:json"`
	Revision  int             `json:"revision" gorm:"not null;default:1"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

// Settings AI 配置。
type Settings struct {
	Revision int        `json:"revision"`
	AI       AISettings `json:"ai"`
}
