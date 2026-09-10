package repository

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func TestCanvasWritesRollbackAfterMediaExpiryUpdateFailure(t *testing.T) {
	for _, operation := range []string{"create", "import", "update", "idempotent_update"} {
		t.Run(operation, func(t *testing.T) {
			useRepositoryTestDB(t, newRepositoryTestConfig(t, "canvas_expiry_rollback"))
			database, err := DB()
			if err != nil {
				t.Fatal(err)
			}
			expiry := time.Date(2026, 9, 7, 1, 2, 3, 0, time.UTC)
			for _, id := range []string{"media-a", "media-b"} {
				if _, err := SaveMedia(model.Media{ID: id, OwnerUID: "owner", Source: model.MediaSourceUpload, ObjectKey: "objects/" + id, ExpiresAt: &expiry}); err != nil {
					t.Fatal(err)
				}
			}
			existing := model.CanvasProject{ID: "existing", OwnerUID: "owner", Title: "preserved", Document: model.CanvasProjectDocument(`{}`), Revision: 3, CreatedAt: "2026-09-01T00:00:00Z", UpdatedAt: "2026-09-02T00:00:00Z"}
			if _, _, err := CreateCanvasProject(existing); err != nil {
				t.Fatal(err)
			}
			receipt := model.CanvasSaveRequest{RequestID: "prior-request", ProjectID: existing.ID, UserUID: "owner", BaseRevision: 2, PayloadHash: "prior-hash", ResultRevision: 3}
			if err := database.Create(&receipt).Error; err != nil {
				t.Fatal(err)
			}
			injected := errors.New("injected media expiry update failure")
			updates := 0
			const callback = "test:fail_second_media_expiry_update"
			if err := database.Callback().Update().After("gorm:update").Register(callback, func(tx *gorm.DB) {
				if tx.Statement.Table != "media" || tx.Error != nil {
					return
				}
				changes, ok := tx.Statement.Dest.(map[string]interface{})
				if !ok {
					return
				}
				if _, exists := changes["expires_at"]; !exists {
					return
				}
				updates++
				if updates == 2 {
					tx.AddError(injected)
				}
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = database.Callback().Update().Remove(callback) })
			document := model.CanvasProjectDocument(`{"nodes":[{"type":"image","metadata":{"mediaId":"media-a"}},{"type":"image","metadata":{"mediaId":"media-b"}}]}`)
			switch operation {
			case "create":
				_, inserted, createErr := CreateCanvasProject(model.CanvasProject{ID: "new", OwnerUID: "owner", Document: document, Revision: 1})
				err = createErr
				if inserted {
					t.Fatal("failed create reported inserted")
				}
			case "import":
				var imported []model.CanvasProject
				imported, err = ImportCanvasProjects([]model.CanvasProject{
					{ID: "existing", OwnerUID: "owner", Title: "must not replace", Document: document, Revision: 1},
					{ID: "new-a", OwnerUID: "owner", Document: model.CanvasProjectDocument(`{}`), Revision: 1},
					{ID: "new-b", OwnerUID: "owner", Document: document, Revision: 1},
				})
				if imported != nil {
					t.Fatalf("failed import returned accepted rows: %#v", imported)
				}
			case "update":
				_, accepted, updateErr := UpdateCanvasProject("owner", existing.ID, 3, "changed", document, "2026-09-07T00:00:00Z")
				err = updateErr
				if accepted {
					t.Fatal("failed update reported accepted")
				}
			case "idempotent_update":
				_, accepted, replayed, updateErr := UpdateCanvasProjectIdempotently("owner", existing.ID, 3, "changed", document, "2026-09-07T00:00:00Z", "new-request", "new-hash")
				err = updateErr
				if accepted || replayed {
					t.Fatal("failed idempotent update reported accepted or replayed")
				}
			}
			if !errors.Is(err, injected) || updates != 2 {
				t.Fatalf("failure = %v, media updates = %d; want injected error after second update", err, updates)
			}
			project, found, err := GetCanvasProject("owner", existing.ID)
			if err != nil || !found || !reflect.DeepEqual(project, existing) {
				t.Fatalf("canvas transaction did not roll back: %#v, found=%t, %v", project, found, err)
			}
			for _, id := range []string{"media-a", "media-b"} {
				item, found, err := GetMedia(id)
				if err != nil || !found || item.ExpiresAt == nil || !item.ExpiresAt.Equal(expiry) || item.OwnerUID != "owner" || item.ObjectKey != "objects/"+id || item.CleanupStatus != model.MediaCleanupActive {
					t.Fatalf("media update did not roll back: %#v, found=%t err=%v", item, found, err)
				}
			}
			var receipts []model.CanvasSaveRequest
			if err := database.Find(&receipts).Error; err != nil {
				t.Fatal(err)
			}
			if len(receipts) != 1 || !reflect.DeepEqual(receipts[0], receipt) {
				t.Fatalf("receipt claim did not roll back: %#v", receipts)
			}
		})
	}
}
