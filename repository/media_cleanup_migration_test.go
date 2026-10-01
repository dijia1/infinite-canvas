package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestMediaCleanupMigrationPreservesLegacyRows(t *testing.T) {
	cfg := newRepositoryTestConfig(t, "media_cleanup_migration")
	useRepositoryTestDB(t, cfg, true)
	legacy, err := gorm.Open(postgres.Open(cfg.DatabaseDSN), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := legacy.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if err := legacy.Exec(`CREATE TABLE media (
 id TEXT PRIMARY KEY, owner_uid TEXT, source TEXT, object_key TEXT,
 content_type TEXT, bytes BIGINT, width BIGINT, height BIGINT,
 filename TEXT, title TEXT, folder_id TEXT, created_at TEXT, expires_at TIMESTAMPTZ
 )`).Error; err != nil {
		t.Fatal(err)
	}
	expiry := time.Date(2026, 9, 7, 1, 2, 3, 456000000, time.UTC)
	for _, row := range []struct {
		id     string
		expiry *time.Time
	}{{"active", nil}, {"pending", &expiry}} {
		if err := legacy.Exec("INSERT INTO media (id, owner_uid, source, object_key, expires_at) VALUES (?, ?, ?, ?, ?)", row.id, "legacy-owner", "upload", "legacy/"+row.id, row.expiry).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"cleanup_status", "cleanup_started_at", "cleanup_claim_id", "cleanup_lease_until"} {
		if legacy.Migrator().HasColumn("media", column) {
			t.Fatalf("legacy fixture already has %s", column)
		}
	}
	if err := MigrateDatabase(); err != nil {
		t.Fatal(err)
	}
	database, err := DB()
	if err != nil {
		t.Fatalf("migrate legacy media: %v", err)
	}
	for _, column := range []string{"cleanup_status", "cleanup_started_at", "cleanup_claim_id", "cleanup_lease_until"} {
		if !database.Migrator().HasColumn(&model.Media{}, column) {
			t.Errorf("migration omitted %s", column)
		}
	}
	var rows []model.Media
	if err := database.Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("migration retained %d rows, want 2", len(rows))
	}
	for _, row := range rows {
		if row.OwnerUID != "legacy-owner" || row.ObjectKey != "legacy/"+row.ID || row.Source != model.MediaSourceUpload || row.CleanupStatus != model.MediaCleanupActive {
			t.Fatalf("legacy media changed during migration: %#v", row)
		}
		if row.CleanupStartedAt != nil || row.CleanupClaimID != "" || row.CleanupLeaseUntil != nil {
			t.Fatalf("legacy row unexpectedly claimed: %#v", row)
		}
		if row.ID == "active" && row.ExpiresAt != nil {
			t.Fatalf("active expiry changed: %v", row.ExpiresAt)
		}
		if row.ID == "pending" && (row.ExpiresAt == nil || !row.ExpiresAt.Equal(expiry)) {
			t.Fatalf("pending expiry changed: %v", row.ExpiresAt)
		}
	}
}
