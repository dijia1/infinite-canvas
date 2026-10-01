package repository

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestDBUsesPostgresAndMigratesCanvasProjects(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "postgres_dialector"))

	database, err := DB()
	if err != nil {
		t.Fatalf("DB() error = %v", err)
	}
	if got := database.Dialector.Name(); got != "postgres" {
		t.Fatalf("database dialector = %q, want postgres", got)
	}
	if !database.Migrator().HasTable(&model.CanvasProject{}) {
		t.Fatal("DB() did not migrate canvas_projects")
	}
}

func TestCanvasProjectDocumentRoundTripsThroughPostgresRepository(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "canvas_document_round_trip"))
	document := model.CanvasProjectDocument(`{
		"nodes":[{"id":"image-1","type":"image","data":{"label":"海报","width":1024}}],
		"edges":[],
		"viewport":{"x":12.5,"y":-8,"zoom":1.25}
	}`)
	_, inserted, err := CreateCanvasProject(model.CanvasProject{
		ID:        "round-trip-project",
		OwnerUID:  "round-trip-owner",
		Title:     "文档往返测试",
		Document:  document,
		Revision:  7,
		CreatedAt: "2026-09-05T01:00:00Z",
		UpdatedAt: "2026-09-05T01:00:00Z",
	})
	if err != nil {
		t.Fatalf("CreateCanvasProject() error = %v", err)
	}
	if !inserted {
		t.Fatal("CreateCanvasProject() inserted = false, want true")
	}
	stored, found, err := GetCanvasProject("round-trip-owner", "round-trip-project")
	if err != nil {
		t.Fatalf("GetCanvasProject() error = %v", err)
	}
	if !found {
		t.Fatal("GetCanvasProject() found = false, want true")
	}
	var expectedDocument any
	if err := json.Unmarshal(document, &expectedDocument); err != nil {
		t.Fatalf("test document is not valid JSON: %v", err)
	}
	var storedDocument any
	if err := json.Unmarshal(stored.Document, &storedDocument); err != nil {
		t.Fatalf("stored document is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(storedDocument, expectedDocument) {
		t.Fatalf("stored document = %s, want JSON-equivalent %s", stored.Document, document)
	}
}

func useLegacyCanvasProjectTestDB(t *testing.T) {
	t.Helper()
	cfg := newRepositoryTestConfig(t, "legacy_canvas_project")
	useRepositoryTestDB(t, cfg, true)
	legacy, err := gorm.Open(postgres.Open(cfg.DatabaseDSN), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec(`CREATE TABLE canvas_projects (
		id TEXT PRIMARY KEY,
		owner_uid TEXT,
		title TEXT,
		document TEXT,
		revision INTEGER,
		created_at TEXT,
		updated_at TEXT
	)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec("CREATE INDEX idx_canvas_projects_owner_uid ON canvas_projects(owner_uid)").Error; err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec(`INSERT INTO canvas_projects (id, owner_uid, title, document, revision, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, "legacy-shared-id", "legacy-owner", "旧画布", `{}`, 1, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").Error; err != nil {
		t.Fatal(err)
	}
	legacyDB, err := legacy.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDBMigratesLegacyCanvasProjectPrimaryKeyForOwnerScopedImports(t *testing.T) {
	useLegacyCanvasProjectTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateDatabase(); err == nil {
		t.Fatal("normal deployment accepted a contract migration")
	}
	if err := migratePostgresCanvasProjectPrimaryKey(database); err != nil {
		t.Fatal(err)
	}
	if err := MigrateDatabase(); err != nil {
		t.Fatal(err)
	}
	if err := migratePostgresCanvasProjectPrimaryKey(database); err != nil {
		t.Fatalf("repeat migration error = %v", err)
	}

	first, err := ImportCanvasProjects([]model.CanvasProject{{ID: "legacy-shared-id", OwnerUID: "legacy-owner", Title: "不应覆盖", Document: model.CanvasProjectDocument(`{}`), Revision: 1}})
	if err != nil || len(first) != 1 || first[0].Title != "旧画布" {
		t.Fatalf("legacy owner import = %#v, %v", first, err)
	}
	second, err := ImportCanvasProjects([]model.CanvasProject{{ID: "legacy-shared-id", OwnerUID: "second-owner", Title: "第二个用户画布", Document: model.CanvasProjectDocument(`{}`), Revision: 1}})
	if err != nil || len(second) != 1 || second[0].OwnerUID != "second-owner" {
		t.Fatalf("second owner import = %#v, %v", second, err)
	}
	firstProject, found, err := GetCanvasProject("legacy-owner", "legacy-shared-id")
	if err != nil || !found || firstProject.Title != "旧画布" {
		t.Fatalf("legacy project after migration = %#v, found=%t, err=%v", firstProject, found, err)
	}
}
