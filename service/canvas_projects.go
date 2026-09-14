package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

const maxCanvasDocumentBytes = 4 << 20
const canvasProjectDocumentTooLargeMessage = "画板数据超过保存上限（4MB）"

var ErrCanvasProjectConflict = errors.New("canvas project revision conflict")
var ErrCanvasProjectDocumentTooLarge = errors.New(canvasProjectDocumentTooLargeMessage)

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
	item := model.CanvasProject{ID: id, OwnerUID: user.UID, Title: title, Document: model.CanvasProjectDocument(document), Revision: 1, CreatedAt: createdAt, UpdatedAt: now()}
	created, _, err := repository.CreateCanvasProject(item)
	if err != nil {
		return model.CanvasProject{}, canvasMediaSaveError(err)
	}
	return created, nil
}

func ImportCanvasProjects(ctx context.Context, user PortalUser, inputs []CanvasProjectInput) (model.CanvasProjectImportResult, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.CanvasProjectImportResult{}, canvasProjectValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	if len(inputs) == 0 || len(inputs) > 200 {
		return model.CanvasProjectImportResult{}, canvasProjectValidationError{message: "导入画布数量应为 1-200 个"}
	}
	seen := make(map[string]struct{}, len(inputs))
	items := make([]model.CanvasProject, 0, len(inputs))
	for _, input := range inputs {
		id, title, document, err := normalizeCanvasProjectInput(input)
		if err != nil {
			return model.CanvasProjectImportResult{}, err
		}
		if _, exists := seen[id]; exists {
			return model.CanvasProjectImportResult{}, canvasProjectValidationError{message: "导入画布 ID 重复"}
		}
		seen[id] = struct{}{}
		createdAt := strings.TrimSpace(input.CreatedAt)
		if createdAt == "" {
			createdAt = now()
		}
		items = append(items, model.CanvasProject{ID: id, OwnerUID: user.UID, Title: title, Document: model.CanvasProjectDocument(document), Revision: 1, CreatedAt: createdAt, UpdatedAt: now()})
	}
	imported, err := repository.ImportCanvasProjects(items)
	if err != nil {
		return model.CanvasProjectImportResult{}, canvasMediaSaveError(err)
	}
	return model.CanvasProjectImportResult{Items: imported, Total: len(imported)}, nil
}

func UpdateCanvasProject(_ context.Context, user PortalUser, id string, input CanvasProjectUpdateInput, requestID string) (model.CanvasProject, bool, error) {
	id, err := normalizeCanvasProjectID(id)
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	if input.Revision < 1 {
		return model.CanvasProject{}, false, ErrCanvasProjectConflict
	}
	title, err := normalizeCanvasProjectTitle(input.Title)
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	document, err := sanitizeCanvasDocumentBase(input.Document)
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	requestID = strings.TrimSpace(requestID)
	if requestID != "" {
		if _, err := uuid.Parse(requestID); err != nil {
			return model.CanvasProject{}, false, canvasProjectValidationError{message: "保存请求标识无效"}
		}
		payloadHash := canvasProjectPayloadHash(title, input.Revision, document)
		if receipt, found, err := repository.GetCanvasSaveRequest(requestID); err != nil {
			return model.CanvasProject{}, false, err
		} else if found {
			if receipt.ProjectID != id || receipt.UserUID != user.UID || receipt.BaseRevision != input.Revision || receipt.PayloadHash != payloadHash {
				return model.CanvasProject{}, false, canvasProjectValidationError{message: "保存请求标识与原请求不一致"}
			}
			return model.CanvasProject{
				ID:        id,
				OwnerUID:  user.UID,
				Title:     title,
				Document:  model.CanvasProjectDocument(append([]byte(nil), document...)),
				Revision:  receipt.ResultRevision,
				CreatedAt: receipt.ResultCreatedAt,
				UpdatedAt: receipt.ResultUpdatedAt,
			}, true, nil
		}
	}
	existing, found, err := repository.GetCanvasProject(user.UID, id)
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	if !found {
		return model.CanvasProject{}, false, safeMessageError{message: "画布不存在"}
	}
	if existing.Revision != input.Revision {
		return model.CanvasProject{}, false, ErrCanvasProjectConflict
	}
	if err := validateCanvasGraphAgainstBaseline(document, json.RawMessage(existing.Document)); err != nil {
		return model.CanvasProject{}, false, err
	}
	if requestID != "" {
		return updateCanvasProjectIdempotently(user.UID, id, input.Revision, title, document, requestID, canvasProjectPayloadHash(title, input.Revision, document))
	}
	updated, accepted, err := repository.UpdateCanvasProject(user.UID, id, input.Revision, title, document, now())
	if err != nil {
		return model.CanvasProject{}, false, canvasMediaSaveError(err)
	}
	if accepted {
		return updated, false, nil
	}
	if _, found, err := repository.GetCanvasProject(user.UID, id); err != nil {
		return model.CanvasProject{}, false, err
	} else if !found {
		return model.CanvasProject{}, false, safeMessageError{message: "画布不存在"}
	}
	return model.CanvasProject{}, false, ErrCanvasProjectConflict
}

func updateCanvasProjectIdempotently(ownerUID, id string, revision int, title string, document []byte, requestID, payloadHash string) (model.CanvasProject, bool, error) {
	updated, accepted, deduplicated, err := repository.UpdateCanvasProjectIdempotently(ownerUID, id, revision, title, document, now(), requestID, payloadHash)
	if errors.Is(err, repository.ErrCanvasSaveRequestMismatch) {
		return model.CanvasProject{}, false, canvasProjectValidationError{message: "保存请求标识与原请求不一致"}
	}
	if err != nil {
		return model.CanvasProject{}, false, canvasMediaSaveError(err)
	}
	if accepted {
		return updated, deduplicated, nil
	}
	if _, found, err := repository.GetCanvasProject(ownerUID, id); err != nil {
		return model.CanvasProject{}, false, err
	} else if !found {
		return model.CanvasProject{}, false, safeMessageError{message: "画布不存在"}
	}
	return model.CanvasProject{}, false, ErrCanvasProjectConflict
}

func canvasProjectPayloadHash(title string, revision int, document []byte) string {
	payload := append([]byte(title+"\x00"+fmt.Sprint(revision)+"\x00"), document...)
	sum := sha256.Sum256(payload)
	return fmt.Sprintf("%x", sum[:])
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
	if value == "." || value == ".." {
		return "", canvasProjectValidationError{message: "画布 ID 包含不安全路径段"}
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
	encoded, object, err := sanitizeCanvasDocumentValue(document)
	if err != nil {
		return nil, err
	}
	if len(canvasGraphViolations(object)) != 0 {
		return nil, canvasProjectValidationError{message: "画布节点或连线关系无效"}
	}
	return encoded, nil
}

func sanitizeCanvasDocumentBase(document json.RawMessage) (json.RawMessage, error) {
	encoded, _, err := sanitizeCanvasDocumentValue(document)
	return encoded, err
}

func sanitizeCanvasDocumentAgainstBaseline(document, baseline json.RawMessage) (json.RawMessage, error) {
	encoded, _, err := sanitizeCanvasDocumentValue(document)
	if err != nil {
		return nil, err
	}
	if err := validateCanvasGraphAgainstBaseline(encoded, baseline); err != nil {
		return nil, err
	}
	return encoded, nil
}

func sanitizeCanvasDocumentValue(document json.RawMessage) (json.RawMessage, map[string]any, error) {
	if len(document) > maxCanvasDocumentBytes {
		return nil, nil, ErrCanvasProjectDocumentTooLarge
	}
	if len(document) == 0 {
		return nil, nil, canvasProjectValidationError{message: "画布内容大小无效"}
	}
	documentObject, err := decodeCanvasDocument(document)
	if err != nil {
		return nil, nil, err
	}
	cleaned := sanitizeCanvasValue(documentObject)
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return nil, nil, err
	}
	return encoded, documentObject, nil
}

func decodeCanvasDocument(document json.RawMessage) (map[string]any, error) {
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
	return documentObject, nil
}

type canvasGraphViolation struct {
	kind      string
	primaryID string
	detail    string
}

func validateCanvasGraphAgainstBaseline(document, baseline json.RawMessage) error {
	candidate, err := decodeCanvasDocument(document)
	if err != nil {
		return err
	}
	baselineDocument, err := decodeCanvasDocument(baseline)
	if err != nil {
		return err
	}
	allowed := canvasGraphViolations(baselineDocument)
	for violation, count := range canvasGraphViolations(candidate) {
		if count > allowed[violation] {
			return canvasProjectValidationError{message: "画布节点或连线关系无效"}
		}
	}
	return nil
}

func canvasGraphViolations(document map[string]any) map[canvasGraphViolation]int {
	violations := make(map[canvasGraphViolation]int)
	nodeIDs := make(map[string]int)
	for _, value := range document["nodes"].([]any) {
		node := value.(map[string]any)
		id := node["id"].(string)
		nodeIDs[id]++
		for _, dimension := range []string{"width", "height"} {
			if !canvasPositiveNumber(node[dimension]) {
				detail := canvasGraphNumberIdentity(node[dimension].(json.Number))
				violations[canvasGraphViolation{kind: "node_" + dimension, primaryID: id, detail: detail}]++
			}
		}
	}
	for id, count := range nodeIDs {
		if count > 1 {
			violations[canvasGraphViolation{kind: "duplicate_node_id", primaryID: id}] += count - 1
		}
	}
	connectionIDs := make(map[string]int)
	for _, value := range document["connections"].([]any) {
		connection := value.(map[string]any)
		id := connection["id"].(string)
		connectionIDs[id]++
		for _, endpoint := range []string{"fromNodeId", "toNodeId"} {
			nodeID := connection[endpoint].(string)
			if nodeIDs[nodeID] == 0 {
				violations[canvasGraphViolation{kind: "missing_" + endpoint, primaryID: id, detail: nodeID}]++
			}
		}
	}
	for id, count := range connectionIDs {
		if count > 1 {
			violations[canvasGraphViolation{kind: "duplicate_connection_id", primaryID: id}] += count - 1
		}
	}
	return violations
}

func canvasGraphNumberIdentity(number json.Number) string {
	if rational, ok := new(big.Rat).SetString(number.String()); ok {
		return rational.RatString()
	}
	return "raw:" + number.String()
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

func canvasMediaSaveError(err error) error {
	if errors.Is(err, repository.ErrCanvasMediaUnavailable) {
		return canvasProjectValidationError{message: "画布引用的图片不存在、无权访问或正在删除，请刷新后重试"}
	}
	if errors.Is(err, repository.ErrCanvasMediaInvalidDocument) {
		return canvasProjectValidationError{message: "画布图片引用数据无效"}
	}
	return err
}
