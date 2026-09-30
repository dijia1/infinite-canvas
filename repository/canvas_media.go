package repository

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrCanvasMediaUnavailable = errors.New("canvas media is missing or unavailable")
var ErrCanvasMediaInvalidDocument = errors.New("canvas media document is invalid")

const canvasMediaCleanupDelay = 5 * time.Minute

// CanvasDocumentMediaIDs fails closed so malformed persisted JSON cannot make
// referenced media appear safe to delete. Image nodes without media IDs may
// contain external images and do not own a stored-media reference.
func CanvasDocumentMediaIDs(document []byte) (map[string]struct{}, error) {
	var parsed *struct {
		Nodes []struct {
			Type     string         `json:"type"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(document, &parsed); err != nil || parsed == nil {
		return nil, ErrCanvasMediaInvalidDocument
	}
	ids := make(map[string]struct{})
	for _, node := range parsed.Nodes {
		if node.Type != "image" && node.Type != "video" {
			continue
		}
		raw, exists := node.Metadata["mediaId"]
		if !exists || raw == nil {
			continue
		}
		id, ok := raw.(string)
		if !ok {
			return nil, ErrCanvasMediaInvalidDocument
		}
		if id = strings.TrimSpace(id); id != "" {
			ids[id] = struct{}{}
		}
	}
	return ids, nil
}

type canvasMediaChange struct {
	ownerUID                string
	projectID               string
	before, after           map[string]struct{}
	beforeNodes, afterNodes []canvasImageReference
	unchanged               map[string]bool
}

func newCanvasMediaChange(ownerUID, projectID string, before, after []byte) (canvasMediaChange, error) {
	change := canvasMediaChange{ownerUID: ownerUID, projectID: projectID, before: make(map[string]struct{})}
	var err error
	if before != nil {
		change.before, err = CanvasDocumentMediaIDs(before)
		if err != nil {
			return change, err
		}
	}
	change.after, err = CanvasDocumentMediaIDs(after)
	if err != nil {
		return change, err
	}
	change.beforeNodes, err = canvasImageReferences(before)
	if err != nil {
		return change, err
	}
	change.afterNodes, err = canvasImageReferences(after)
	if err != nil {
		return change, err
	}
	previous := map[string]canvasImageReference{}
	for _, node := range change.beforeNodes {
		previous[node.ID] = node
	}
	change.unchanged = map[string]bool{}
	for _, node := range change.afterNodes {
		if node.Type != "image" && node.Type != "video" {
			continue
		}
		id := canvasReferenceString(node, "mediaId")
		if id == "" {
			continue
		}
		old, found := previous[node.ID]
		same := found && node.ID != "" && canvasReferenceString(old, "publicImageId") != "" && sameCanvasImageReference(node, old)
		prior, seen := change.unchanged[id]
		change.unchanged[id] = same && (!seen || prior)
	}
	return change, nil
}

// Call only after all affected canvas rows have been locked/inserted. Cleanup
// takes these same media row locks before checking references and claiming work.
func applyCanvasMediaChanges(tx *gorm.DB, changes []canvasMediaChange) error {
	ids := make(map[string]struct{})
	for _, change := range changes {
		for id := range change.before {
			ids[id] = struct{}{}
		}
		for id := range change.after {
			ids[id] = struct{}{}
		}
	}
	publicIDs := map[string]bool{}
	for _, change := range changes {
		for _, node := range change.afterNodes {
			if node.Type == "image" {
				if id := canvasReferenceString(node, "publicImageId"); id != "" {
					publicIDs[id] = true
				}
			}
		}
	}
	publicIDList := make([]string, 0, len(publicIDs))
	for id := range publicIDs {
		publicIDList = append(publicIDList, id)
	}
	var namedPublic []model.PublicImage
	if len(publicIDList) > 0 {
		if err := tx.Where("id IN ?", publicIDList).Find(&namedPublic).Error; err != nil {
			return err
		}
		for _, item := range namedPublic {
			ids[item.MediaID] = struct{}{}
		}
	}
	if len(ids) == 0 && len(publicIDs) == 0 {
		return nil
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	var items []model.Media
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id IN ?", ordered).Order("id").Find(&items).Error; err != nil {
		return err
	}
	media := make(map[string]model.Media, len(items))
	for _, item := range items {
		media[item.ID] = item
	}
	var publicItems []model.PublicImage
	if err := tx.Select("media_id").Where("media_id IN ?", ordered).Find(&publicItems).Error; err != nil {
		return err
	}
	public := make(map[string]struct{}, len(publicItems))
	for _, item := range publicItems {
		public[item.MediaID] = struct{}{}
	}
	// Re-read public names after taking their media locks. Deletion may have won
	// between the initial lookup and this lock acquisition.
	namedPublic = nil
	if len(publicIDList) > 0 {
		if err := tx.Where("id IN ?", publicIDList).Find(&namedPublic).Error; err != nil {
			return err
		}
	}
	byPublicID := map[string]model.PublicImage{}
	for _, item := range namedPublic {
		byPublicID[item.ID] = item
	}
	for _, change := range changes {
		previous := map[string]canvasImageReference{}
		for _, node := range change.beforeNodes {
			previous[node.ID] = node
		}
		for _, node := range change.afterNodes {
			if node.Type != "image" {
				continue
			}
			publicID := canvasReferenceString(node, "publicImageId")
			if publicID == "" {
				continue
			}
			if private, exists := media[canvasReferenceString(node, "mediaId")]; exists && private.OwnerUID == change.ownerUID && private.CleanupStatus == model.MediaCleanupActive {
				continue
			}
			old, existed := previous[node.ID]
			unchanged := existed && node.ID != "" && sameCanvasImageReference(node, old)
			public, found := byPublicID[publicID]
			item, available := media[public.MediaID]
			if !found || !available || item.CleanupStatus != model.MediaCleanupActive {
				if !unchanged {
					return ErrCanvasMediaUnavailable
				}
				continue
			}
			if id := canvasReferenceString(node, "mediaId"); id != "" && id != public.MediaID {
				return ErrCanvasMediaUnavailable
			}
		}
	}
	for _, change := range changes {
		for id := range change.after {
			item, found := media[id]
			_, isPublic := public[id]
			if !found || item.CleanupStatus != model.MediaCleanupActive || (item.OwnerUID != change.ownerUID && !isPublic) {
				if !change.unchanged[id] {
					return ErrCanvasMediaUnavailable
				}
			}
		}
	}
	for _, change := range changes {
		for _, id := range ordered {
			_, before := change.before[id]
			_, after := change.after[id]
			if before == after {
				continue
			}
			event := "reference_added"
			if before {
				event = "reference_removed"
			}
			item := media[id]
			item.ID = id
			if err := recordMediaLifecycle(tx, item, change.ownerUID, event, change.projectID, "canvas_saved"); err != nil {
				return err
			}
		}
	}
	// Read persisted references once per owner after every canvas write in this
	// transaction, including all actual inserts in an import batch.
	references := make(map[string]map[string]struct{})
	expiresAt := time.Now().UTC().Add(canvasMediaCleanupDelay)
	updates := make(map[string]*time.Time)
	for _, change := range changes {
		for id := range change.after {
			if media[id].OwnerUID == change.ownerUID {
				updates[id] = nil
			}
		}
		for id := range change.before {
			if _, retained := change.after[id]; retained {
				continue
			}
			item, exists := media[id]
			if !exists || item.OwnerUID != change.ownerUID || item.CleanupStatus != model.MediaCleanupActive {
				continue
			}
			if _, isPublic := public[id]; isPublic {
				continue
			}
			refs, loaded := references[change.ownerUID]
			if !loaded {
				var err error
				refs, err = canvasMediaReferences(tx, change.ownerUID)
				if err != nil {
					return err
				}
				references[change.ownerUID] = refs
			}
			if _, retained := refs[id]; !retained {
				workflowHeld, err := workflowMediaReferenced(tx, id)
				if err != nil {
					return err
				}
				if !workflowHeld {
					updates[id] = &expiresAt
				}
			}
		}
	}
	for _, id := range ordered {
		expiry, changed := updates[id]
		if !changed {
			continue
		}
		item := media[id]
		expiry = preserveMaskExpiry(item, expiry)
		if mediaExpiryEqual(item.ExpiresAt, expiry) {
			continue
		}
		if (item.ExpiresAt == nil && expiry != nil) || (item.ExpiresAt != nil && expiry == nil) {
			event, reason := "cleanup_scheduled", "no_saved_canvas_reference"
			if expiry == nil {
				event, reason = "cleanup_cancelled", "canvas_reference_restored"
			}
			item.ExpiresAt = expiry
			if err := recordMediaLifecycle(tx, item, "", event, "", reason); err != nil {
				return err
			}
		}
		if err := tx.Model(&model.Media{}).Where("id = ?", id).Update("expires_at", expiry).Error; err != nil {
			return err
		}
	}
	return nil
}

func canvasMediaReferences(tx *gorm.DB, ownerUID string) (map[string]struct{}, error) {
	rows, err := tx.Model(&model.CanvasProject{}).Select("document").Where("owner_uid = ?", ownerUID).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	references := make(map[string]struct{})
	for rows.Next() {
		var document []byte
		if err := rows.Scan(&document); err != nil {
			return nil, err
		}
		ids, err := CanvasDocumentMediaIDs(document)
		if err != nil {
			return nil, err
		}
		for id := range ids {
			references[id] = struct{}{}
		}
	}
	return references, rows.Err()
}
