package repository

import (
	"encoding/json"
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrPublicImageCanvasReferenced = errors.New("公共图片仍被历史画板使用，请先打开对应画板完成个人副本转换")

type canvasImageReference struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Metadata map[string]any `json:"metadata"`
}

func canvasImageReferences(document []byte) ([]canvasImageReference, error) {
	if document == nil {
		return nil, nil
	}
	var parsed struct {
		Nodes []canvasImageReference `json:"nodes"`
	}
	if err := json.Unmarshal(document, &parsed); err != nil {
		return nil, ErrCanvasMediaInvalidDocument
	}
	return parsed.Nodes, nil
}
func canvasReferenceString(node canvasImageReference, key string) string {
	value, _ := node.Metadata[key].(string)
	return value
}
func sameCanvasImageReference(a, b canvasImageReference) bool {
	if a.ID != b.ID || a.Type != b.Type {
		return false
	}
	for _, key := range []string{"mediaId", "publicImageId", "assetId"} {
		if canvasReferenceString(a, key) != canvasReferenceString(b, key) {
			return false
		}
	}
	return true
}
func publicImageCanvasReferenced(tx *gorm.DB, publicID, mediaID string) (bool, error) {
	filters := make([][]byte, 0, 3)
	for _, kind := range []string{"image", "video"} {
		raw, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"type": kind, "metadata": map[string]any{"mediaId": mediaID}}}})
		filters = append(filters, raw)
	}
	raw, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"type": "image", "metadata": map[string]any{"publicImageId": publicID}}}})
	filters = append(filters, raw)
	var items []model.CanvasProject
	err := tx.Select("id").Where("CASE WHEN document IS JSON THEN (document::jsonb @> ?::jsonb OR document::jsonb @> ?::jsonb OR document::jsonb @> ?::jsonb) ELSE (POSITION(? IN document) > 0 OR POSITION(? IN document) > 0) END", string(filters[0]), string(filters[1]), string(filters[2]), mediaID, publicID).Limit(1).Find(&items).Error
	return len(items) > 0, err
}
