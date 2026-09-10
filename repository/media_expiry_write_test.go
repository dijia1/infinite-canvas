package repository

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

type mediaExpiryWrites struct{ calls, rows atomic.Int64 }

// Observe actual GORM updates against PostgreSQL, including statements affecting
// zero rows: replacing an unconditional UPDATE with a no-op SQL still costs a call.
func observeMediaExpiryWrites(t *testing.T, database *gorm.DB) *mediaExpiryWrites {
	t.Helper()
	writes := &mediaExpiryWrites{}
	const callback = "test:observe_media_expiry_writes"
	if err := database.Callback().Update().After("gorm:update").Register(callback, func(tx *gorm.DB) {
		if tx.Statement.Table != "media" || tx.Error != nil {
			return
		}
		changes, ok := tx.Statement.Dest.(map[string]interface{})
		if !ok {
			return
		}
		if _, ok := changes["expires_at"]; ok {
			writes.calls.Add(1)
			writes.rows.Add(tx.RowsAffected)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Callback().Update().Remove(callback) })
	return writes
}

func (w *mediaExpiryWrites) expect(t *testing.T, calls, rows int64) {
	t.Helper()
	if gotCalls, gotRows := w.calls.Swap(0), w.rows.Swap(0); gotCalls != calls || gotRows != rows {
		t.Errorf("expires_at UPDATE calls/rows = %d/%d, want %d/%d", gotCalls, gotRows, calls, rows)
	}
}

func TestPrivateMediaExpirySkipsUnchangedWrites(t *testing.T) {
	a := time.Date(2026, 9, 10, 9, 0, 0, 123456000, time.UTC)
	b := a.Add(time.Hour)
	aInOtherZone := a.In(time.FixedZone("UTC+8", 8*60*60))
	aBeforeDatabasePrecision := a.Add(789 * time.Nanosecond)
	for _, test := range []struct {
		name          string
		old, next     *time.Time
		wantWrites    int64
		wantNewEvents int
	}{
		{"null_to_null", nil, nil, 0, 0},
		{"time_a_to_time_a", &a, &a, 0, 0},
		{"time_a_to_null", &a, nil, 1, 1},
		{"null_to_time_b", nil, &b, 1, 1},
		{"time_a_to_time_b", &a, &b, 1, 1},
		{"same_instant_other_zone", &a, &aInOtherZone, 0, 0},
		{"same_database_microsecond", &a, &aBeforeDatabasePrecision, 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			useRepositoryTestDB(t, newRepositoryTestConfig(t, "expiry_write_matrix"))
			database, err := DB()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := SaveMedia(model.Media{ID: "media", OwnerUID: "owner", ObjectKey: "media", ExpiresAt: test.old}); err != nil {
				t.Fatal(err)
			}
			beforeEvents := len(lifecycleEvents(t, "media"))
			writes := observeMediaExpiryWrites(t, database)
			accepted, err := SetPrivateMediaExpiry("media", "owner", test.next)
			if err != nil || !accepted {
				t.Fatalf("accepted=%t err=%v; no-op must preserve successful-call semantics", accepted, err)
			}
			writes.expect(t, test.wantWrites, test.wantWrites)
			current, found, err := GetMedia("media")
			if err != nil || !found {
				t.Fatalf("media found=%t err=%v", found, err)
			}
			if test.next == nil {
				if current.ExpiresAt != nil {
					t.Fatalf("expiry=%v, want NULL", current.ExpiresAt)
				}
			} else if current.ExpiresAt == nil || !current.ExpiresAt.Equal(test.next.Truncate(time.Microsecond)) {
				t.Fatalf("expiry=%v, want %v at database precision", current.ExpiresAt, test.next)
			}
			if got := len(lifecycleEvents(t, "media")) - beforeEvents; got != test.wantNewEvents {
				t.Errorf("new audit events=%d, want %d", got, test.wantNewEvents)
			}
		})
	}
}

func TestCanvasRetainedMediaSkipsWritesButPreservesRevisionsAndReplay(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "canvas_retained_expiry"))
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SaveMedia(model.Media{ID: "media", OwnerUID: "owner", ObjectKey: "media"}); err != nil {
		t.Fatal(err)
	}
	doc := model.CanvasProjectDocument(`{"nodes":[{"type":"image","metadata":{"mediaId":"media"}}]}`)
	writes := observeMediaExpiryWrites(t, database)
	if _, inserted, err := CreateCanvasProject(model.CanvasProject{ID: "canvas", OwnerUID: "owner", Document: doc, Revision: 1}); err != nil || !inserted {
		t.Fatalf("create inserted=%t err=%v", inserted, err)
	}
	writes.expect(t, 0, 0)
	beforeEvents := len(lifecycleEvents(t, "media"))
	for _, replay := range []bool{false, true} {
		saved, accepted, replayed, err := UpdateCanvasProjectIdempotently("owner", "canvas", 1, "moved", doc, "2026-09-10T00:00:00Z", "same-request", "same-payload")
		if err != nil || !accepted || replayed != replay || saved.Revision != 2 {
			t.Fatalf("save revision=%d accepted=%t replay=%t err=%v", saved.Revision, accepted, replayed, err)
		}
		writes.expect(t, 0, 0)
	}
	if _, accepted, _, err := UpdateCanvasProjectIdempotently("owner", "canvas", 1, "stale", doc, "", "other-request", "other-payload"); err != nil || accepted {
		t.Fatalf("stale revision accepted=%t err=%v", accepted, err)
	}
	writes.expect(t, 0, 0)
	if got := len(lifecycleEvents(t, "media")); got != beforeEvents {
		t.Fatalf("unchanged references added audit: %d -> %d", beforeEvents, got)
	}
	// Removing the last reference must still schedule the existing five-minute delay.
	start := time.Now().UTC()
	if _, accepted, err := UpdateCanvasProject("owner", "canvas", 2, "removed", []byte(`{}`), ""); err != nil || !accepted {
		t.Fatalf("remove accepted=%t err=%v", accepted, err)
	}
	writes.expect(t, 1, 1)
	media, _, err := GetMedia("media")
	if err != nil || media.ExpiresAt == nil || media.ExpiresAt.Before(start.Add(5*time.Minute-time.Second)) || media.ExpiresAt.After(time.Now().Add(5*time.Minute+time.Second)) {
		t.Fatalf("cleanup deadline=%v err=%v", media.ExpiresAt, err)
	}
	if _, accepted, err := UpdateCanvasProject("owner", "canvas", 3, "restored", doc, ""); err != nil || !accepted {
		t.Fatalf("restore accepted=%t err=%v", accepted, err)
	}
	writes.expect(t, 1, 1)
	if got := len(lifecycleEvents(t, "media")); got != beforeEvents+4 {
		t.Fatalf("release/restore audit events=%d, want %d", got, beforeEvents+4)
	}
}

func TestWorkflowRetainedMediaSkipsWritesButPreservesReferenceAudit(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retained_expiry"))
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SaveMedia(model.Media{ID: "media", OwnerUID: "owner", ObjectKey: "media"}); err != nil {
		t.Fatal(err)
	}
	writes := observeMediaExpiryWrites(t, database)
	replace := func(scope, id string, ids []string) {
		t.Helper()
		if err := database.Transaction(func(tx *gorm.DB) error { return ReplaceWorkflowMediaRefs(tx, "owner", scope, id, ids) }); err != nil {
			t.Fatal(err)
		}
	}
	replace("definition", "workflow", []string{"media", "media"})
	writes.expect(t, 0, 0)
	beforeEvents := len(lifecycleEvents(t, "media"))
	replace("definition", "workflow", []string{"media"})
	writes.expect(t, 0, 0)
	if len(lifecycleEvents(t, "media")) != beforeEvents {
		t.Fatal("unchanged workflow references added audit")
	}
	replace("run", "run", []string{"media"})
	writes.expect(t, 0, 0)
	replace("definition", "workflow", nil)
	writes.expect(t, 0, 0)
	replace("run", "run", nil)
	writes.expect(t, 1, 1)
	replace("definition", "workflow", []string{"media"})
	writes.expect(t, 1, 1)
	if len(lifecycleEvents(t, "media")) != beforeEvents+4 {
		t.Fatal("workflow reference audit changed")
	}
}

func TestUnchangedMediaReferencesStillRejectUnavailableRows(t *testing.T) {
	for _, kind := range []string{"canvas", "workflow"} {
		for _, state := range []string{"deleting", "foreign", "missing"} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				useRepositoryTestDB(t, newRepositoryTestConfig(t, "retained_media_validation"))
				database, err := DB()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := SaveMedia(model.Media{ID: "media", OwnerUID: "owner", ObjectKey: "media"}); err != nil {
					t.Fatal(err)
				}
				doc := model.CanvasProjectDocument(`{"nodes":[{"type":"image","metadata":{"mediaId":"media"}}]}`)
				if kind == "canvas" {
					_, _, err = CreateCanvasProject(model.CanvasProject{ID: "canvas", OwnerUID: "owner", Document: doc, Revision: 1})
				} else {
					err = database.Transaction(func(tx *gorm.DB) error {
						return ReplaceWorkflowMediaRefs(tx, "owner", "definition", "workflow", []string{"media"})
					})
				}
				if err != nil {
					t.Fatal(err)
				}
				switch state {
				case "deleting":
					err = database.Model(&model.Media{}).Where("id = ?", "media").Update("cleanup_status", model.MediaCleanupDeleting).Error
				case "foreign":
					err = database.Model(&model.Media{}).Where("id = ?", "media").Update("owner_uid", "other").Error
				case "missing":
					err = database.Delete(&model.Media{}, "id = ?", "media").Error
				}
				if err != nil {
					t.Fatal(err)
				}
				beforeEvents := len(lifecycleEvents(t, "media"))
				writes := observeMediaExpiryWrites(t, database)
				if kind == "canvas" {
					_, _, err = UpdateCanvasProject("owner", "canvas", 1, "must not save", doc, "")
					project, found, readErr := GetCanvasProject("owner", "canvas")
					if readErr != nil || !found || project.Revision != 1 {
						t.Fatalf("failed save advanced revision: %+v %v", project, readErr)
					}
				} else {
					err = database.Transaction(func(tx *gorm.DB) error {
						return ReplaceWorkflowMediaRefs(tx, "owner", "definition", "workflow", []string{"media"})
					})
				}
				if !errors.Is(err, ErrCanvasMediaUnavailable) {
					t.Fatalf("unchanged references bypassed media validation: %v", err)
				}
				writes.expect(t, 0, 0)
				if len(lifecycleEvents(t, "media")) != beforeEvents {
					t.Fatal("failed validation persisted audit")
				}
			})
		}
	}
}
