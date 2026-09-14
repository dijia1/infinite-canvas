package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type settingsCASResult struct {
	settings model.Settings
	err      error
}

func TestSettingsMigrationInitializesLegacyRevisionWithoutChangingData(t *testing.T) {
	cfg := newRepositoryTestConfig(t, "settings_revision_migration")
	useRepositoryTestDB(t, cfg)
	legacy, err := gorm.Open(postgres.Open(cfg.DatabaseDSN), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec(`CREATE TABLE settings (
		key text PRIMARY KEY,
		value jsonb,
		created_at text,
		updated_at text
	)`).Error; err != nil {
		t.Fatal(err)
	}
	const createdAt = "2025-01-02T03:04:05Z"
	const updatedAt = "2025-06-07T08:09:10Z"
	const value = `{"providers":[{"id":"legacy","config":{"apiKey":"legacy-secret"}}],"futureField":{"keep":true}}`
	if err := legacy.Exec("INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?::jsonb, ?, ?)", model.SettingKeyAI, value, createdAt, updatedAt).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec("INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, 'true'::jsonb, ?, ?)", explicitAspectRatiosMigration, createdAt, updatedAt).Error; err != nil {
		t.Fatal(err)
	}
	var storedValueBefore string
	if err := legacy.Raw("SELECT value::text FROM settings WHERE key = ?", model.SettingKeyAI).Scan(&storedValueBefore).Error; err != nil {
		t.Fatal(err)
	}
	legacySQL, err := legacy.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := legacySQL.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	var got model.Setting
	if err := database.First(&got, "key = ?", model.SettingKeyAI).Error; err != nil {
		t.Fatal(err)
	}
	if got.Revision != 1 {
		t.Fatalf("legacy revision = %d, want 1", got.Revision)
	}
	if got.CreatedAt != createdAt || got.UpdatedAt != updatedAt {
		t.Fatalf("legacy timestamps = %q/%q, want %q/%q", got.CreatedAt, got.UpdatedAt, createdAt, updatedAt)
	}
	var storedValueAfter string
	if err := database.Raw("SELECT value::text FROM settings WHERE key = ?", model.SettingKeyAI).Scan(&storedValueAfter).Error; err != nil {
		t.Fatal(err)
	}
	if storedValueAfter != storedValueBefore {
		t.Fatalf("legacy value changed during revision migration: before=%s after=%s", storedValueBefore, storedValueAfter)
	}
	var before, after any
	if err := json.Unmarshal([]byte(value), &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got.Value, &after); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("legacy value changed: before=%s after=%s", value, got.Value)
	}
	columns, err := database.Migrator().ColumnTypes(&model.Setting{})
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range columns {
		if column.Name() != "revision" {
			continue
		}
		nullable, ok := column.Nullable()
		if !ok || nullable {
			t.Fatalf("revision nullable = %t, known=%t; want NOT NULL", nullable, ok)
		}
		defaultValue, ok := column.DefaultValue()
		if !ok || strings.Trim(defaultValue, "'::integer ") != "1" {
			t.Fatalf("revision default = %q, known=%t; want 1", defaultValue, ok)
		}
		return
	}
	t.Fatal("revision column was not migrated")
}

func TestSettingsRevisionLifecycleAndZeroRevisionConflict(t *testing.T) {
	cfg := newRepositoryTestConfig(t, "settings_revision_lifecycle")
	useRepositoryTestDB(t, cfg)

	empty, err := GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if empty.Revision != 0 {
		t.Fatalf("empty revision = %d, want 0", empty.Revision)
	}
	created, err := SaveSettings(model.Settings{Revision: 0, AI: model.AISettings{}}, "2026-09-14T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 {
		t.Fatalf("created revision = %d, want 1", created.Revision)
	}
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.Setting{}).Where("key = ?", model.SettingKeyAI).Update("revision", 0).Error; err != nil {
		t.Fatal(err)
	}
	_, err = SaveSettings(model.Settings{Revision: 0, AI: model.AISettings{}}, "2026-09-14T00:00:01Z")
	var conflict *SettingsRevisionConflictError
	if !errors.As(err, &conflict) || conflict.CurrentRevision != 0 {
		t.Fatalf("zero-revision save error = %#v, want typed conflict at revision 0", err)
	}
}

func TestSettingsCASUsesTwoWaitingClientsAndKeepsWinningDocumentWhole(t *testing.T) {
	cfg := newRepositoryTestConfig(t, "settings_revision_concurrency")
	useRepositoryTestDB(t, cfg)
	created, err := SaveSettings(model.Settings{AI: model.AISettings{}}, "2026-09-14T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	clientA, err := GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	clientB, err := GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if clientA.Revision != created.Revision || clientB.Revision != created.Revision {
		t.Fatalf("client revisions = %d/%d, want %d", clientA.Revision, clientB.Revision, created.Revision)
	}
	clientA.AI.Providers = []model.AIProvider{{ID: "a", Name: "client-a", Config: json.RawMessage(`{"secret":"a-secret"}`)}}
	clientA.AI.ImageProviderID = "a"
	clientB.AI.Providers = []model.AIProvider{{ID: "b", Name: "client-b", Config: json.RawMessage(`{"secret":"b-secret"}`)}}
	clientB.AI.VideoProviderID = "b"

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	blocker := database.Begin()
	if blocker.Error != nil {
		t.Fatal(blocker.Error)
	}
	defer blocker.Rollback()
	var locked model.Setting
	if err := blocker.Set("gorm:query_option", "FOR UPDATE").Raw("SELECT * FROM settings WHERE key = ? FOR UPDATE", model.SettingKeyAI).Scan(&locked).Error; err != nil {
		t.Fatal(err)
	}
	var blockerPID int
	if err := blocker.Raw("SELECT pg_backend_pid()").Scan(&blockerPID).Error; err != nil {
		t.Fatal(err)
	}

	pids := make(chan int, 2)
	var callbackMu sync.Mutex
	seenPIDs := map[int]bool{}
	callbackName := "test_settings_cas_backend_pid"
	if err := database.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != "settings" {
			return
		}
		var pid int
		if err := tx.Statement.ConnPool.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			tx.AddError(err)
			return
		}
		callbackMu.Lock()
		if !seenPIDs[pid] {
			seenPIDs[pid] = true
			pids <- pid
		}
		callbackMu.Unlock()
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Callback().Update().Remove(callbackName) })

	results := make(chan settingsCASResult, 2)
	go func() {
		settings, err := SaveSettings(clientA, "2026-09-14T00:00:01Z")
		results <- settingsCASResult{settings: settings, err: err}
	}()
	go func() {
		settings, err := SaveSettings(clientB, "2026-09-14T00:00:02Z")
		results <- settingsCASResult{settings: settings, err: err}
	}()
	waitingPIDs := []int{awaitSettingsPID(t, pids), awaitSettingsPID(t, pids)}
	if waitingPIDs[0] == waitingPIDs[1] || waitingPIDs[0] == blockerPID || waitingPIDs[1] == blockerPID {
		t.Fatalf("CAS did not use three independent connections: blocker=%d writers=%v", blockerPID, waitingPIDs)
	}
	for _, pid := range waitingPIDs {
		awaitSettingsLockWait(t, database, pid)
	}
	if err := blocker.Commit().Error; err != nil {
		t.Fatal(err)
	}

	first := awaitSettingsResult(t, results)
	second := awaitSettingsResult(t, results)
	var winner model.Settings
	conflicts := 0
	for _, item := range []settingsCASResult{first, second} {
		if item.err == nil {
			winner = item.settings
			continue
		}
		var conflict *SettingsRevisionConflictError
		if !errors.As(item.err, &conflict) || conflict.CurrentRevision != created.Revision+1 {
			t.Fatalf("writer error = %#v, want conflict at %d", item.err, created.Revision+1)
		}
		conflicts++
	}
	if winner.Revision != created.Revision+1 || conflicts != 1 {
		t.Fatalf("winner revision/conflicts = %d/%d, want %d/1", winner.Revision, conflicts, created.Revision+1)
	}
	stored, err := GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	storedJSON, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	winnerJSON, err := json.Marshal(winner)
	if err != nil {
		t.Fatal(err)
	}
	var storedDocument, winnerDocument any
	if err := json.Unmarshal(storedJSON, &storedDocument); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(winnerJSON, &winnerDocument); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(storedDocument, winnerDocument) {
		t.Fatalf("stored settings mixed documents: stored=%#v winner=%#v", stored, winner)
	}
}

func awaitSettingsPID(t *testing.T, pids <-chan int) int {
	t.Helper()
	select {
	case pid := <-pids:
		return pid
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for settings writer connection")
		return 0
	}
}

func awaitSettingsLockWait(t *testing.T, database *gorm.DB, pid int) {
	t.Helper()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := database.Raw("SELECT COALESCE(wait_event_type = 'Lock', false) FROM pg_stat_activity WHERE pid = ?", pid).Scan(&waiting).Error; err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("PostgreSQL writer %d never entered a lock wait", pid)
		case <-ticker.C:
		}
	}
}

func awaitSettingsResult(t *testing.T, results <-chan settingsCASResult) settingsCASResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for settings CAS result")
		return settingsCASResult{}
	}
}
