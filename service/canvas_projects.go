package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const maxCanvasDocumentBytes = 2 << 20

var ErrCanvasProjectConflict = errors.New("canvas project revision conflict")

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
	item, found, err := repository.GetCanvasProject(user.UID, strings.TrimSpace(id))
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
	created, inserted, err := repository.CreateCanvasProject(item)
	if err != nil {
		return model.CanvasProject{}, err
	}
	if !inserted {
		return model.CanvasProject{}, canvasProjectValidationError{message: "画布已存在"}
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
	updated, err := repository.UpdateCanvasProject(user.UID, strings.TrimSpace(id), input.Revision, title, document, now())
	if err != nil {
		return model.CanvasProject{}, err
	}
	if updated {
		item, found, err := repository.GetCanvasProject(user.UID, strings.TrimSpace(id))
		if err != nil {
			return model.CanvasProject{}, err
		}
		if found {
			return item, nil
		}
	}
	if _, found, err := repository.GetCanvasProject(user.UID, strings.TrimSpace(id)); err != nil {
		return model.CanvasProject{}, err
	} else if !found {
		return model.CanvasProject{}, safeMessageError{message: "画布不存在"}
	}
	return model.CanvasProject{}, ErrCanvasProjectConflict
}

func DeleteCanvasProject(_ context.Context, user PortalUser, id string, revision int) error {
	if revision < 1 {
		return ErrCanvasProjectConflict
	}
	deleted, err := repository.DeleteCanvasProject(user.UID, strings.TrimSpace(id), revision)
	if err != nil {
		return err
	}
	if deleted {
		return nil
	}
	if _, found, err := repository.GetCanvasProject(user.UID, strings.TrimSpace(id)); err != nil {
		return err
	} else if !found {
		return safeMessageError{message: "画布不存在"}
	}
	return ErrCanvasProjectConflict
}

func normalizeCanvasProjectInput(input CanvasProjectInput) (string, string, json.RawMessage, error) {
	id := strings.TrimSpace(input.ID)
	if length := utf8.RuneCountInString(id); length < 1 || length > 128 {
		return "", "", nil, canvasProjectValidationError{message: "画布 ID 长度应为 1-128 个字符"}
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
	if _, ok := value.(map[string]any); !ok {
		return nil, canvasProjectValidationError{message: "画布内容必须是对象"}
	}
	cleaned := sanitizeCanvasValue(value)
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func sanitizeCanvasValue(value any) any {
	switch current := value.(type) {
	case map[string]any:
		cleaned := make(map[string]any, len(current))
		for key, child := range current {
			if text, ok := child.(string); ok && isTransientCanvasImageContent(text) {
				continue
			}
			cleaned[key] = sanitizeCanvasValue(child)
		}
		return cleaned
	case []any:
		cleaned := make([]any, len(current))
		for index, child := range current {
			if text, ok := child.(string); ok && isTransientCanvasImageContent(text) {
				continue
			}
			cleaned[index] = sanitizeCanvasValue(child)
		}
		return cleaned
	default:
		return value
	}
}

func isTransientCanvasImageContent(value string) bool {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "blob:") || strings.HasPrefix(lower, "data:image/") {
		return true
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	for key := range parsed.Query() {
		key = strings.ToLower(key)
		if strings.HasPrefix(key, "x-amz-") || strings.HasPrefix(key, "x-oss-") || key == "signature" || key == "ossaccesskeyid" || key == "security-token" || key == "expires" {
			return true
		}
	}
	return false
}
