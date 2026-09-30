package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

type CanvasPublicImageReplacement struct {
	NodeID              string `json:"nodeId"`
	SourceMediaID       string `json:"sourceMediaId"`
	SourcePublicImageID string `json:"sourcePublicImageId"`
	MediaID             string `json:"mediaId"`
}
type CanvasPublicImageImportResult struct {
	Project        model.CanvasProject            `json:"project"`
	Replacements   []CanvasPublicImageReplacement `json:"replacements"`
	MissingNodeIDs []string                       `json:"missingNodeIds"`
	PendingNodeIDs []string                       `json:"pendingNodeIds"`
}

func ImportCanvasPublicImages(ctx context.Context, user PortalUser, id string, revision int) (CanvasPublicImageImportResult, error) {
	store, err := newImageStore()
	if err != nil {
		return CanvasPublicImageImportResult{}, err
	}
	return importCanvasPublicImages(ctx, store, user, id, revision)
}

// Only the persisted, owner-scoped document supplies sources. The POST accepts
// a revision, never a client-chosen public image ID or replacement document.
func importCanvasPublicImages(ctx context.Context, store imageStore, user PortalUser, id string, revision int) (CanvasPublicImageImportResult, error) {
	result := CanvasPublicImageImportResult{Replacements: []CanvasPublicImageReplacement{}, MissingNodeIDs: []string{}, PendingNodeIDs: []string{}}
	project, err := GetCanvasProject(ctx, user, id)
	if err != nil {
		return result, err
	}
	if project.Revision != revision {
		return result, ErrCanvasProjectConflict
	}
	result.Project = project
	var doc map[string]any
	if err := json.Unmarshal(project.Document, &doc); err != nil {
		return result, err
	}
	nodes, _ := doc["nodes"].([]any)
	copies := map[string]model.Media{}
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if node["type"] != "image" {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		sourceMediaID, _ := metadata["mediaId"].(string)
		publicID, _ := metadata["publicImageId"].(string)
		nodeID, _ := node["id"].(string)
		var public model.PublicImage
		found := false
		if publicID != "" {
			public, found, err = repository.GetPublicImage(publicID)
		} else if sourceMediaID != "" {
			public, found, err = repository.GetPublicImageByMediaID(sourceMediaID)
		} else {
			continue
		}
		if err != nil {
			return result, err
		}
		// Some old documents retain an origin label after receiving a personal
		// copy. The authorized primary media wins; never replace its content.
		if publicID != "" && sourceMediaID != "" && (!found || sourceMediaID != public.MediaID) {
			private, owned, lookupErr := repository.GetMedia(sourceMediaID)
			if lookupErr != nil {
				return result, lookupErr
			}
			if owned && private.OwnerUID == user.UID && private.CleanupStatus == model.MediaCleanupActive {
				_, stillPublic, lookupErr := repository.GetPublicImageByMediaID(sourceMediaID)
				if lookupErr != nil {
					return result, lookupErr
				}
				if !stillPublic {
					result.Replacements = append(result.Replacements, CanvasPublicImageReplacement{NodeID: nodeID, SourceMediaID: sourceMediaID, SourcePublicImageID: publicID, MediaID: sourceMediaID})
					metadata["storageKey"] = "media:" + sourceMediaID
					delete(metadata, "publicImageId")
					delete(metadata, "assetId")
					continue
				}
			}
		}
		if !found {
			if publicID != "" {
				result.MissingNodeIDs = append(result.MissingNodeIDs, nodeID)
			}
			continue
		}
		if sourceMediaID != "" && sourceMediaID != public.MediaID {
			result.MissingNodeIDs = append(result.MissingNodeIDs, nodeID)
			continue
		}
		if sourceMediaID == "" {
			sourceMediaID = public.MediaID
		}
		copy, exists := copies[public.MediaID]
		if !exists {
			// Stable across revision changes and lost responses, but isolated by owner
			// and canvas. Separate user import gestures continue to get separate copies.
			request, requestErr := canvasPublicImportRequest(user.UID, project.ID, public.MediaID)
			if requestErr != nil {
				return result, requestErr
			}
			copy, err = importPublicImage(ctx, store, user, public.ID, request)
			if err != nil {
				var missing publicImageSourceVersionError
				if errors.As(err, &missing) {
					result.MissingNodeIDs = append(result.MissingNodeIDs, nodeID)
				} else {
					result.PendingNodeIDs = append(result.PendingNodeIDs, nodeID)
				}
				continue
			}
			copies[public.MediaID] = copy
		}
		result.Replacements = append(result.Replacements, CanvasPublicImageReplacement{NodeID: nodeID, SourceMediaID: sourceMediaID, SourcePublicImageID: public.ID, MediaID: copy.ID})
		metadata["mediaId"] = copy.ID
		metadata["storageKey"] = "media:" + copy.ID
		for _, key := range []string{"publicImageId", "assetId", "content", "mediaExpiresAt", "errorDetails"} {
			delete(metadata, key)
		}
	}
	if len(result.Replacements) == 0 {
		return result, nil
	}
	document, err := json.Marshal(doc)
	if err != nil {
		return result, err
	}
	saved, accepted, err := repository.UpdateCanvasProject(user.UID, project.ID, revision, project.Title, document, now())
	if err != nil {
		return result, fmt.Errorf("保存公共图片转换: %w", err)
	}
	if !accepted {
		return result, ErrCanvasProjectConflict
	}
	result.Project = saved
	return result, nil
}

// Renew only an expired reservation or a confirmed deleted copy. Ambiguous,
// unexpired Copy results keep their original key and request identity.
func canvasPublicImportRequest(owner, projectID, sourceMediaID string) (string, error) {
	request := uuid.NewSHA1(uuid.NameSpaceURL, []byte("canvas-public:"+projectID+":"+sourceMediaID))
	for range 32 {
		intent, found, err := repository.GetMediaUploadIntentForOwner(publicImageImportIntentID(owner, request), owner)
		if err != nil {
			return "", err
		}
		if !found {
			return request.String(), nil
		}
		if intent.CompletedMediaID != "" {
			item, found, err := repository.GetMedia(intent.CompletedMediaID)
			if err != nil {
				return "", err
			}
			if found && item.CleanupStatus == model.MediaCleanupActive {
				return request.String(), nil
			}
		} else {
			expiry, err := time.Parse(time.RFC3339Nano, intent.ExpiresAt)
			if err != nil {
				return "", err
			}
			if time.Now().Before(expiry) {
				return request.String(), nil
			}
		}
		request = uuid.NewSHA1(uuid.NameSpaceURL, []byte("renew:"+intent.ID+":"+intent.CompletedMediaID))
	}
	return "", safeMessageError{message: "公共图片转换重试次数超限，请联系管理员"}
}
