package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const maxCanvasDocumentBytes = 2 << 20

var ErrCanvasProjectConflict = errors.New("canvas project revision conflict")

var canvasProjectIDPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type CanvasProjectInput struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Document  json.RawMessage `json:"document"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

type CanvasProjectUpdateInput struct {
	Revision int             `json:"revision"`
	Title    string          `json:"title"`
	Document json.RawMessage `json:"document"`
}

type canvasProjectValidationError struct{ message string }

func (err canvasProjectValidationError) Error() string       { return err.message }
func (err canvasProjectValidationError) SafeMessage() string { return err.message }

func IsCanvasProjectValidationError(err error) bool {
	var validation canvasProjectValidationError
	return errors.As(err, &validation)
}

func ListCanvasProjects(_ context.Context, user PortalUser) (model.CanvasProjectList, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.CanvasProjectList{}, canvasProjectValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	items, err := repository.ListCanvasProjects(user.UID)
	if err != nil {
		return model.CanvasProjectList{}, err
	}
	return model.CanvasProjectList{Items: items, Total: len(items)}, nil
}

func GetCanvasProject(_ context.Context, user PortalUser, id string) (model.CanvasProject, error) {
	id, err := normalizeCanvasProjectID(id)
	if err != nil {
		return model.CanvasProject{}, err
	}
	item, found, err := repository.GetCanvasProject(user.UID, id)
	if err != nil {
		return model.CanvasProject{}, err
	}
	if !found {
		return model.CanvasProject{}, safeMessageError{message: "画布不存在"}
	}
	return item, nil
}

func CreateCanvasProject(_ context.Context, user PortalUser, input CanvasProjectInput) (model.CanvasProject, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.CanvasProject{}, canvasProjectValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	id, title, document, err := normalizeCanvasProjectInput(input)
	if err != nil {
		return model.CanvasProject{}, err
	}
	createdAt := strings.TrimSpace(input.CreatedAt)
	if createdAt == "" {
		createdAt = now()
	}
	item := model.CanvasProject{ID: id, OwnerUID: user.UID, Title: title, Document: document, Revision: 1, CreatedAt: createdAt, UpdatedAt: now()}
	created, _, err := repository.CreateCanvasProject(item)
	if err != nil {
		return model.CanvasProject{}, err
	}
	return created, nil
}

func ImportCanvasProjects(ctx context.Context, user PortalUser, inputs []CanvasProjectInput) (model.CanvasProjectList, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.CanvasProjectList{}, canvasProjectValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	if len(inputs) == 0 || len(inputs) > 200 {
		return model.CanvasProjectList{}, canvasProjectValidationError{message: "导入画布数量应为 1-200 个"}
	}
	seen := make(map[string]struct{}, len(inputs))
	items := make([]model.CanvasProject, 0, len(inputs))
	for _, input := range inputs {
		id, title, document, err := normalizeCanvasProjectInput(input)
		if err != nil {
			return model.CanvasProjectList{}, err
		}
		if _, exists := seen[id]; exists {
			return model.CanvasProjectList{}, canvasProjectValidationError{message: "导入画布 ID 重复"}
		}
		seen[id] = struct{}{}
		createdAt := strings.TrimSpace(input.CreatedAt)
		if createdAt == "" {
			createdAt = now()
		}
		items = append(items, model.CanvasProject{ID: id, OwnerUID: user.UID, Title: title, Document: document, Revision: 1, CreatedAt: createdAt, UpdatedAt: now()})
	}
	imported, err := repository.ImportCanvasProjects(items)
	if err != nil {
		return model.CanvasProjectList{}, err
	}
	return model.CanvasProjectList{Items: imported, Total: len(imported)}, nil
}

func UpdateCanvasProject(_ context.Context, user PortalUser, id string, input CanvasProjectUpdateInput) (model.CanvasProject, error) {
	id, err := normalizeCanvasProjectID(id)
	if err != nil {
		return model.CanvasProject{}, err
	}
	if input.Revision < 1 {
		return model.CanvasProject{}, ErrCanvasProjectConflict
	}
	title, err := normalizeCanvasProjectTitle(input.Title)
	if err != nil {
		return model.CanvasProject{}, err
	}
	document, err := sanitizeCanvasDocument(input.Document)
	if err != nil {
		return model.CanvasProject{}, err
	}
	updated, accepted, err := repository.UpdateCanvasProject(user.UID, id, input.Revision, title, document, now())
	if err != nil {
		return model.CanvasProject{}, err
	}
	if accepted {
		return updated, nil
	}
	if _, found, err := repository.GetCanvasProject(user.UID, id); err != nil {
		return model.CanvasProject{}, err
	} else if !found {
		return model.CanvasProject{}, safeMessageError{message: "画布不存在"}
	}
	return model.CanvasProject{}, ErrCanvasProjectConflict
}

func DeleteCanvasProject(_ context.Context, user PortalUser, id string, revision int) error {
	id, err := normalizeCanvasProjectID(id)
	if err != nil {
		return err
	}
	if revision < 1 {
		return ErrCanvasProjectConflict
	}
	deleted, err := repository.DeleteCanvasProject(user.UID, id, revision)
	if err != nil {
		return err
	}
	if deleted {
		return nil
	}
	if _, found, err := repository.GetCanvasProject(user.UID, id); err != nil {
		return err
	} else if !found {
		return nil
	}
	return ErrCanvasProjectConflict
}

func normalizeCanvasProjectInput(input CanvasProjectInput) (string, string, json.RawMessage, error) {
	id, err := normalizeCanvasProjectID(input.ID)
	if err != nil {
		return "", "", nil, err
	}
	title, err := normalizeCanvasProjectTitle(input.Title)
	if err != nil {
		return "", "", nil, err
	}
	document, err := sanitizeCanvasDocument(input.Document)
	if err != nil {
		return "", "", nil, err
	}
	return id, title, document, nil
}

func normalizeCanvasProjectID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if length := utf8.RuneCountInString(value); length < 1 || length > 128 {
		return "", canvasProjectValidationError{message: "画布 ID 长度应为 1-128 个字符"}
	}
	if !canvasProjectIDPattern.MatchString(value) {
		return "", canvasProjectValidationError{message: "画布 ID 包含不安全字符"}
	}
	return value, nil
}

func normalizeCanvasProjectTitle(value string) (string, error) {
	value = strings.TrimSpace(value)
	if length := utf8.RuneCountInString(value); length < 1 || length > 128 {
		return "", canvasProjectValidationError{message: "画布名称长度应为 1-128 个字符"}
	}
	return value, nil
}

func sanitizeCanvasDocument(document json.RawMessage) (json.RawMessage, error) {
	if len(document) == 0 || len(document) > maxCanvasDocumentBytes {
		return nil, canvasProjectValidationError{message: "画布内容大小无效"}
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, canvasProjectValidationError{message: "画布内容格式无效"}
	}
	if decoder.More() {
		return nil, canvasProjectValidationError{message: "画布内容格式无效"}
	}
	documentObject, ok := value.(map[string]any)
	if !ok {
		return nil, canvasProjectValidationError{message: "画布内容必须是对象"}
	}
	if err := validateCanvasDocument(documentObject); err != nil {
		return nil, err
	}
	cleaned := sanitizeCanvasValue(documentObject)
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func validateCanvasDocument(document map[string]any) error {
	nodes, ok := document["nodes"].([]any)
	if !ok {
		return canvasProjectValidationError{message: "画布节点必须是数组"}
	}
	for _, value := range nodes {
		node, ok := value.(map[string]any)
		if !ok || !nonEmptyCanvasString(node["id"]) || !canvasNodeType(node["type"]) {
			return canvasProjectValidationError{message: "画布节点格式无效"}
		}
		if _, ok := node["title"].(string); !ok || !canvasPoint(node["position"], false) || !canvasNumber(node["width"]) || !canvasNumber(node["height"]) {
			return canvasProjectValidationError{message: "画布节点格式无效"}
		}
		if metadata, exists := node["metadata"]; exists && metadata != nil {
			if _, ok := metadata.(map[string]any); !ok {
				return canvasProjectValidationError{message: "画布节点格式无效"}
			}
		}
	}

	connections, ok := document["connections"].([]any)
	if !ok {
		return canvasProjectValidationError{message: "画布连线必须是数组"}
	}
	for _, value := range connections {
		connection, ok := value.(map[string]any)
		if !ok || !nonEmptyCanvasString(connection["id"]) || !nonEmptyCanvasString(connection["fromNodeId"]) || !nonEmptyCanvasString(connection["toNodeId"]) {
			return canvasProjectValidationError{message: "画布连线格式无效"}
		}
	}

	backgroundMode, ok := document["backgroundMode"].(string)
	if !ok || (backgroundMode != "dots" && backgroundMode != "lines" && backgroundMode != "blank") {
		return canvasProjectValidationError{message: "画布背景模式无效"}
	}
	if _, ok := document["showImageInfo"].(bool); !ok {
		return canvasProjectValidationError{message: "画布图片信息设置无效"}
	}
	if !canvasPoint(document["viewport"], true) {
		return canvasProjectValidationError{message: "画布视口格式无效"}
	}
	return nil
}

func nonEmptyCanvasString(value any) bool {
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) != ""
}

func canvasNodeType(value any) bool {
	text, ok := value.(string)
	return ok && (text == "image" || text == "text" || text == "config" || text == "video")
}

func canvasPoint(value any, viewport bool) bool {
	point, ok := value.(map[string]any)
	if !ok || !canvasNumber(point["x"]) || !canvasNumber(point["y"]) {
		return false
	}
	if !viewport {
		return true
	}
	return canvasPositiveNumber(point["k"])
}

func canvasNumber(value any) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	parsed, err := number.Float64()
	return err == nil && !math.IsInf(parsed, 0) && !math.IsNaN(parsed)
}

func canvasPositiveNumber(value any) bool {
	if !canvasNumber(value) {
		return false
	}
	parsed, _ := value.(json.Number).Float64()
	return parsed > 0
}

func sanitizeCanvasValue(value any) any {
	document, ok := value.(map[string]any)
	if !ok {
		return value
	}
	nodes, ok := document["nodes"].([]any)
	if !ok {
		return document
	}
	for _, item := range nodes {
		node, ok := item.(map[string]any)
		if !ok || (node["type"] != "image" && node["type"] != "video") {
			continue
		}
		metadata, ok := node["metadata"].(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"content", "url", "previewUrl", "thumbnailUrl", "coverUrl"} {
			if text, ok := metadata[key].(string); ok && isTransientCanvasImageContent(text) {
				delete(metadata, key)
			}
		}
		if access, ok := metadata["access"].(map[string]any); ok {
			for key, child := range access {
				if text, ok := child.(string); ok && isTransientCanvasImageContent(text) {
					delete(access, key)
				}
			}
		}
		if references, ok := metadata["references"].([]any); ok {
			retained := make([]any, 0, len(references))
			retainedIndexes := make([]int, 0, len(references))
			for index, child := range references {
				if text, ok := child.(string); ok && isTransientCanvasImageContent(text) {
					continue
				}
				retained = append(retained, child)
				retainedIndexes = append(retainedIndexes, index)
			}
			if len(retained) != len(references) {
				metadata["references"] = retained
				if masks, ok := metadata["referenceMasks"].([]any); ok {
					retainedMasks := make([]any, 0, len(retainedIndexes))
					for _, index := range retainedIndexes {
						if index < len(masks) {
							retainedMasks = append(retainedMasks, masks[index])
						}
					}
					metadata["referenceMasks"] = retainedMasks
				}
			}
		}
	}
	return document
}

func isTransientCanvasImageContent(value string) bool {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "blob:") || strings.HasPrefix(lower, "data:") {
		return true
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	for key := range parsed.Query() {
		key = strings.ToLower(key)
		if strings.HasPrefix(key, "x-amz-") || strings.HasPrefix(key, "x-oss-") || strings.HasPrefix(key, "x-goog-") || key == "signature" || key == "sig" || key == "ossaccesskeyid" || key == "security-token" || key == "expires" {
			return true
		}
	}
	return false
}
