package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const maxCanvasShareRecipients = 50
const canvasShareTimeout = 105 * time.Second

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
	ctx, cancel := context.WithTimeout(ctx, canvasShareTimeout)
	defer cancel()
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
		if ctx.Err() != nil {
			result.Deliveries = append(result.Deliveries, CanvasShareDelivery{RecipientUserUID: recipient.UserUID, Status: "failed", Message: "分享等待超时，请重试检查原分享结果"})
			continue
		}
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
			message := "分享失败，请稍后重试"
			if ctx.Err() != nil {
				message = "分享等待超时，请重试检查原分享结果"
			}
			log.Printf("canvas share failed project_id=%s recipient_uid=%s: %v", source.ID, recipient.UserUID, err)
			result.Deliveries = append(result.Deliveries, CanvasShareDelivery{RecipientUserUID: recipient.UserUID, Status: "failed", Message: message})
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
		if typeName != "image" && typeName != "video" {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		mediaID, _ := metadata["mediaId"].(string)
		if typeName == "video" && (strings.TrimSpace(mediaID) == "" || metadata["status"] == "loading") {
			return nil, nil, canvasProjectValidationError{message: "请先完成视频上传或生成，再分享画布"}
		}
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
		if !found || item.CleanupStatus == model.MediaCleanupDeleting {
			return nil, canvasProjectValidationError{message: "画布素材不存在"}
		}
		_, public, err := repository.GetPublicImageByMediaID(item.ID)
		if err != nil {
			return nil, err
		}
		if item.OwnerUID != user.UID && !public {
			return nil, canvasProjectValidationError{message: "画布包含无权分享的素材"}
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
	encoded, err = sanitizeCanvasDocumentAgainstBaseline(encoded, json.RawMessage(source.Document))
	if err != nil {
		cleanupCanvasShareMedia(ctx, store, created)
		return model.CanvasProject{}, err
	}
	item := model.CanvasProject{ID: projectID, OwnerUID: recipient.UserUID, Title: canvasShareTitle(source.Title, PortalDisplayName(sender)), Document: model.CanvasProjectDocument(encoded), Revision: 1, CreatedAt: now(), UpdatedAt: now()}
	if err := ctx.Err(); err != nil {
		cleanupCanvasShareMedia(ctx, store, created)
		return model.CanvasProject{}, err
	}
	createdProject, inserted, err := repository.CreateCanvasProject(item, ctx)
	if err != nil {
		// A commit response can be lost. Keep tracked copies until the retention worker
		// checks persisted references, rather than deleting a possibly published result.
		return model.CanvasProject{}, err
	}
	if !inserted {
		cleanupCanvasShareMedia(ctx, store, created)
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
	if err := ctx.Err(); err != nil {
		return model.Media{}, err
	}
	if versioned, ok := store.(mediaVersionStore); ok {
		bound, err := bindMediaVersion(ctx, versioned, source)
		if err != nil {
			return model.Media{}, err
		}
		if bound.Bytes <= 0 || bound.Bytes > maxMediaBytes {
			return model.Media{}, errors.New("分享素材大小无效")
		}
		if strings.HasPrefix(bound.ContentType, "video/") && bound.ContentType != "video/mp4" {
			return model.Media{}, errors.New("仅支持分享 MP4 视频")
		}
		extension := strings.TrimPrefix(filepath.Ext(bound.ObjectKey), ".")
		if extension == "" {
			extension = strings.TrimPrefix(filepath.Ext(bound.Filename), ".")
		}
		if extension == "" {
			return model.Media{}, errors.New("分享素材格式无效")
		}
		expiry := time.Now().Add(24 * time.Hour)
		item := model.Media{ID: newID("media"), OwnerUID: recipientUID, Source: model.MediaSourceUpload, ObjectKey: privateImageObjectKey(recipientUID, model.MediaSourceUpload, extension, time.Now()), ContentType: bound.ContentType, Bytes: bound.Bytes, Width: bound.Width, Height: bound.Height, Duration: bound.Duration, Filename: bound.Filename, Title: bound.Title, CreatedAt: now(), ExpiresAt: &expiry}
		if _, err = repository.SaveMedia(item, ctx); err != nil {
			return model.Media{}, err
		}
		metadata, err := versioned.CopyVersion(ctx, bound.ObjectKey, bound.ObjectVersionID, bound.ObjectETag, item.ObjectKey)
		if err != nil {
			return model.Media{}, err
		}
		return persistMediaCopyIdentity(ctx, item, metadata)
	}
	// Unpublished copies remain eligible for the existing media cleanup worker after a crash.
	expiresAt := time.Now().Add(24 * time.Hour)
	if strings.HasPrefix(source.ContentType, "video/") {
		if source.ContentType != "video/mp4" {
			return model.Media{}, errors.New("仅支持分享 MP4 视频")
		}
		metadata, err := store.Head(ctx, source.ObjectKey)
		if err != nil {
			return model.Media{}, err
		}
		if metadata.Bytes <= 0 || metadata.Bytes > maxMediaBytes {
			return model.Media{}, errors.New("分享视频大小无效，最大 50 MB")
		}
		copier, ok := store.(interface {
			Copy(context.Context, string, string) error
		})
		if !ok {
			return model.Media{}, errors.New("当前存储不支持视频复制")
		}
		key := privateImageObjectKey(recipientUID, model.MediaSourceUpload, "mp4", time.Now())
		item := model.Media{ID: newID("media"), OwnerUID: recipientUID, Source: model.MediaSourceUpload, ObjectKey: key, ContentType: source.ContentType, Bytes: metadata.Bytes, Width: source.Width, Height: source.Height, Duration: source.Duration, Filename: source.Filename, Title: source.Title, CreatedAt: now(), ExpiresAt: &expiresAt}
		if _, err := repository.SaveMedia(item, ctx); err != nil {
			return model.Media{}, err
		}
		if err := copier.Copy(ctx, source.ObjectKey, key); err != nil {
			// A timed-out OSS copy may still finish. Retain its expiring record for deferred cleanup.
			return model.Media{}, err
		}
		return item, nil
	}
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
	item := model.Media{ID: newID("media"), OwnerUID: recipientUID, Source: model.MediaSourceUpload, ObjectKey: key, ContentType: source.ContentType, Bytes: int64(len(data)), Width: source.Width, Height: source.Height, Filename: source.Filename, Title: source.Title, CreatedAt: now(), ExpiresAt: &expiresAt}
	if _, err := repository.SaveMedia(item, ctx); err != nil {
		return model.Media{}, err
	}
	if err := store.Put(ctx, key, data, source.ContentType); err != nil {
		return model.Media{}, err
	}
	return item, nil
}

func cleanupCanvasShareMedia(ctx context.Context, store imageStore, items []model.Media) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, item := range items {
		if cleanupCtx.Err() != nil {
			return
		}
		if err := deleteImageObject(cleanupCtx, store, item.ObjectKey); err != nil {
			auditMediaFailure(item, "", "delete_failed", "share_cleanup_failed")
			log.Printf("canvas share cleanup object failed media_id=%s: %v", item.ID, err)
			continue
		}
		if err := repository.DeleteMedia(item.ID, cleanupCtx); err != nil {
			log.Printf("canvas share cleanup record failed media_id=%s: %v", item.ID, err)
		}
	}
}

func rewriteCanvasShareMedia(document map[string]any, replacements map[string]string) error {
	nodes, _ := document["nodes"].([]any)
	for _, item := range nodes {
		node, _ := item.(map[string]any)
		if node["type"] != "image" && node["type"] != "video" {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		sourceID, _ := metadata["mediaId"].(string)
		targetID, ok := replacements[sourceID]
		if !ok {
			return errors.New("分享图片引用无效")
		}
		metadata["mediaId"] = targetID
		if node["type"] == "video" {
			for key := range metadata {
				if strings.HasPrefix(key, "videoTask") {
					delete(metadata, key)
				}
			}
			for _, key := range []string{"storageKey", "content", "url", "previewUrl", "thumbnailUrl", "coverUrl", "access", "errorDetails"} {
				delete(metadata, key)
			}
			metadata["status"] = "success"
		} else {
			metadata["storageKey"] = "media:" + targetID + ":v1:original"
		}
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
