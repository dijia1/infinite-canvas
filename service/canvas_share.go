package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const maxCanvasShareRecipients = 50

type CanvasShareInput struct {
	Revision          int      `json:"revision"`
	RecipientUserUIDs []string `json:"recipientUserUids"`
}

type CanvasShareDelivery struct {
	RecipientUserUID string `json:"recipientUserUid"`
	ProjectID        string `json:"projectId,omitempty"`
	Status           string `json:"status"`
	Message          string `json:"message,omitempty"`
}

type CanvasShareResult struct {
	Deliveries []CanvasShareDelivery `json:"deliveries"`
}

type CanvasShareRecipient struct {
	UserUID     string   `json:"userUid"`
	DisplayName string   `json:"displayName"`
	Roles       []string `json:"roles"`
}

type CanvasShareRecipientList struct {
	Items []CanvasShareRecipient `json:"items"`
	Total int                    `json:"total"`
}

func ListCanvasShareRecipients(senderUID string, query model.PortalMemberQuery) (CanvasShareRecipientList, error) {
	items, total, err := repository.ListCanvasShareRecipients(strings.TrimSpace(senderUID), query)
	if err != nil {
		return CanvasShareRecipientList{}, err
	}
	result := CanvasShareRecipientList{Items: make([]CanvasShareRecipient, 0, len(items)), Total: int(total)}
	for _, item := range items {
		roles := item.Roles
		if roles == nil {
			roles = []string{}
		}
		result.Items = append(result.Items, CanvasShareRecipient{UserUID: item.UserUID, DisplayName: item.DisplayName, Roles: roles})
	}
	return result, nil
}

func ShareCanvasProject(ctx context.Context, user PortalUser, sourceID string, input CanvasShareInput) (CanvasShareResult, error) {
	if strings.TrimSpace(user.UID) == "" {
		return CanvasShareResult{}, canvasProjectValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	if input.Revision < 1 {
		return CanvasShareResult{}, ErrCanvasProjectConflict
	}
	recipients, err := normalizeCanvasShareRecipients(user.UID, input.RecipientUserUIDs)
	if err != nil {
		return CanvasShareResult{}, err
	}
	source, err := GetCanvasProject(ctx, user, sourceID)
	if err != nil {
		return CanvasShareResult{}, err
	}
	if source.Revision != input.Revision {
		return CanvasShareResult{}, ErrCanvasProjectConflict
	}
	document, mediaIDs, err := canvasShareDocument(source.Document)
	if err != nil {
		return CanvasShareResult{}, err
	}
	media, err := canvasShareSourceMedia(user, mediaIDs)
	if err != nil {
		return CanvasShareResult{}, err
	}
	var store imageStore
	result := CanvasShareResult{Deliveries: make([]CanvasShareDelivery, 0, len(recipients))}
	for _, recipient := range recipients {
		projectID := canvasShareProjectID(source.ID, source.Revision, recipient.UserUID)
		if existing, found, err := repository.GetCanvasProject(recipient.UserUID, projectID); err != nil {
			return CanvasShareResult{}, err
		} else if found {
			result.Deliveries = append(result.Deliveries, CanvasShareDelivery{RecipientUserUID: recipient.UserUID, ProjectID: existing.ID, Status: "shared"})
			continue
		}
		if store == nil {
			store, err = newImageStore()
			if err != nil {
				return CanvasShareResult{}, err
			}
		}
		project, err := copyCanvasShareProject(ctx, store, source, document, media, recipient, projectID, user)
		if err != nil {
			result.Deliveries = append(result.Deliveries, CanvasShareDelivery{RecipientUserUID: recipient.UserUID, Status: "failed", Message: "分享失败，请稍后重试"})
			continue
		}
		result.Deliveries = append(result.Deliveries, CanvasShareDelivery{RecipientUserUID: recipient.UserUID, ProjectID: project.ID, Status: "shared"})
	}
	return result, nil
}

func normalizeCanvasShareRecipients(senderUID string, values []string) ([]model.PortalMember, error) {
	if len(values) == 0 || len(values) > maxCanvasShareRecipients {
		return nil, canvasProjectValidationError{message: "分享成员数量应为 1-50 人"}
	}
	seen := make(map[string]struct{}, len(values))
	items := make([]model.PortalMember, 0, len(values))
	for _, value := range values {
		uid := strings.TrimSpace(value)
		if uid == "" || uid == senderUID {
			return nil, canvasProjectValidationError{message: "分享成员无效"}
		}
		if _, ok := seen[uid]; ok {
			return nil, canvasProjectValidationError{message: "分享成员重复"}
		}
		seen[uid] = struct{}{}
		member, found, err := repository.GetPortalMember(uid)
		if err != nil {
			return nil, err
		}
		if !found || !member.Enabled {
			return nil, canvasProjectValidationError{message: "分享成员不可用"}
		}
		items = append(items, member)
	}
	return items, nil
}

func canvasShareDocument(raw model.CanvasProjectDocument) (map[string]any, []string, error) {
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, nil, errors.New("画布内容格式无效")
	}
	nodes, _ := document["nodes"].([]any)
	mediaSet := make(map[string]struct{})
	for _, item := range nodes {
		node, _ := item.(map[string]any)
		typeName, _ := node["type"].(string)
		if typeName == "video" {
			return nil, nil, canvasProjectValidationError{message: "画布包含视频，暂不支持分享"}
		}
		if typeName != "image" {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		mediaID, _ := metadata["mediaId"].(string)
		if strings.TrimSpace(mediaID) == "" {
			return nil, nil, canvasProjectValidationError{message: "画布包含无法复制的图片"}
		}
		mediaSet[mediaID] = struct{}{}
	}
	mediaIDs := make([]string, 0, len(mediaSet))
	for id := range mediaSet {
		mediaIDs = append(mediaIDs, id)
	}
	sort.Strings(mediaIDs)
	return document, mediaIDs, nil
}

func canvasShareSourceMedia(user PortalUser, ids []string) (map[string]model.Media, error) {
	items := make(map[string]model.Media, len(ids))
	for _, id := range ids {
		item, found, err := repository.GetMedia(id)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, canvasProjectValidationError{message: "画布图片不存在"}
		}
		_, public, err := repository.GetPublicImageByMediaID(item.ID)
		if err != nil {
			return nil, err
		}
		if item.OwnerUID != user.UID && !public {
			return nil, canvasProjectValidationError{message: "画布包含无权分享的图片"}
		}
		items[id] = item
	}
	return items, nil
}

func copyCanvasShareProject(ctx context.Context, store imageStore, source model.CanvasProject, document map[string]any, sourceMedia map[string]model.Media, recipient model.PortalMember, projectID string, sender PortalUser) (model.CanvasProject, error) {
	targetDocument, err := cloneCanvasShareDocument(document)
	if err != nil {
		return model.CanvasProject{}, err
	}
	mediaIDs := make(map[string]string, len(sourceMedia))
	created := make([]model.Media, 0, len(sourceMedia))
	sourceIDs := make([]string, 0, len(sourceMedia))
	for sourceID := range sourceMedia {
		sourceIDs = append(sourceIDs, sourceID)
	}
	sort.Strings(sourceIDs)
	for _, sourceID := range sourceIDs {
		item := sourceMedia[sourceID]
		copied, err := copyCanvasShareMedia(ctx, store, item, recipient.UserUID)
		if err != nil {
			cleanupCanvasShareMedia(ctx, store, created)
			return model.CanvasProject{}, err
		}
		created = append(created, copied)
		mediaIDs[sourceID] = copied.ID
	}
	if err := rewriteCanvasShareMedia(targetDocument, mediaIDs); err != nil {
		cleanupCanvasShareMedia(ctx, store, created)
		return model.CanvasProject{}, err
	}
	encoded, err := json.Marshal(targetDocument)
	if err != nil {
		cleanupCanvasShareMedia(ctx, store, created)
		return model.CanvasProject{}, err
	}
	encoded, err = sanitizeCanvasDocument(encoded)
	if err != nil {
		cleanupCanvasShareMedia(ctx, store, created)
		return model.CanvasProject{}, err
	}
	item := model.CanvasProject{ID: projectID, OwnerUID: recipient.UserUID, Title: canvasShareTitle(source.Title, PortalDisplayName(sender)), Document: model.CanvasProjectDocument(encoded), Revision: 1, CreatedAt: now(), UpdatedAt: now()}
	createdProject, inserted, err := repository.CreateCanvasProject(item)
	if err != nil || !inserted {
		cleanupCanvasShareMedia(ctx, store, created)
		if err != nil {
			return model.CanvasProject{}, err
		}
		return createdProject, nil
	}
	return createdProject, nil
}

func cloneCanvasShareDocument(source map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(source)
	if err != nil {
		return nil, err
	}
	var target map[string]any
	if err := json.Unmarshal(encoded, &target); err != nil {
		return nil, err
	}
	return target, nil
}

func copyCanvasShareMedia(ctx context.Context, store imageStore, source model.Media, recipientUID string) (model.Media, error) {
	file, err := store.Get(ctx, source.ObjectKey)
	if err != nil {
		return model.Media{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxMediaBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxMediaBytes {
		return model.Media{}, errors.New("读取分享图片失败")
	}
	extension := strings.TrimPrefix(filepath.Ext(source.Filename), ".")
	if extension == "" {
		extension = strings.TrimPrefix(filepath.Ext(source.ObjectKey), ".")
	}
	if extension == "" {
		return model.Media{}, errors.New("分享图片格式无效")
	}
	key := privateImageObjectKey(recipientUID, model.MediaSourceUpload, extension, time.Now())
	if err := store.Put(ctx, key, data, source.ContentType); err != nil {
		return model.Media{}, err
	}
	item := model.Media{ID: newID("media"), OwnerUID: recipientUID, Source: model.MediaSourceUpload, ObjectKey: key, ContentType: source.ContentType, Bytes: int64(len(data)), Width: source.Width, Height: source.Height, Filename: source.Filename, Title: source.Title, CreatedAt: now()}
	if _, err := repository.SaveMedia(item); err != nil {
		_ = store.Delete(ctx, key)
		return model.Media{}, err
	}
	return item, nil
}

func cleanupCanvasShareMedia(ctx context.Context, store imageStore, items []model.Media) {
	for _, item := range items {
		_ = repository.DeleteMedia(item.ID)
		_ = store.Delete(ctx, item.ObjectKey)
	}
}

func rewriteCanvasShareMedia(document map[string]any, replacements map[string]string) error {
	nodes, _ := document["nodes"].([]any)
	for _, item := range nodes {
		node, _ := item.(map[string]any)
		if node["type"] != "image" {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		sourceID, _ := metadata["mediaId"].(string)
		targetID, ok := replacements[sourceID]
		if !ok {
			return errors.New("分享图片引用无效")
		}
		metadata["mediaId"] = targetID
		metadata["storageKey"] = "media:" + targetID + ":v1:original"
		delete(metadata, "mediaExpiresAt")
		delete(metadata, "publicImageId")
		delete(metadata, "assetId")
	}
	return nil
}

func canvasShareProjectID(sourceID string, revision int, recipientUID string) string {
	sum := sha256.Sum256([]byte(sourceID + "\x00" + fmt.Sprint(revision) + "\x00" + recipientUID))
	return "share-" + hex.EncodeToString(sum[:16])
}

func canvasShareTitle(title, sender string) string {
	value := strings.TrimSpace(title) + "（来自 " + strings.TrimSpace(sender) + "）"
	if len([]rune(value)) <= 128 {
		return value
	}
	return string([]rune(value)[:128])
}
