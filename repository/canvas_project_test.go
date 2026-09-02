package repository

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func useLegacyCanvasProjectTestDB(t *testing.T) {
	t.Helper()
	previousConfig, previousDB, previousErr, previousOnce := config.Cfg, db, dbErr, dbOnce
	path := filepath.Join(t.TempDir(), "legacy-canvas.db")
	legacy, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
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
		VALUES (?, ?, ?, ?, ?, ?, ?)`, "legacy-shared-id", "legacy-owner", "旧画布", []byte(`{}`), 1, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").Error; err != nil {
		t.Fatal(err)
	}
	legacyDB, err := legacy.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Close(); err != nil {
		t.Fatal(err)
	}

	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: path}
	db = nil
	dbErr = nil
	dbOnce = sync.Once{}
	t.Cleanup(func() {
		config.Cfg = previousConfig
		db = previousDB
		dbErr = previousErr
		dbOnce = previousOnce
	})
}

func TestDBMigratesLegacyCanvasProjectPrimaryKeyForOwnerScopedImports(t *testing.T) {
	useLegacyCanvasProjectTestDB(t)
	database, err := DB()
	if err != nil {
		t.Fatalf("DB() migration error = %v", err)
	}
	if err := migrateCanvasProjectPrimaryKey(database, "sqlite"); err != nil {
		t.Fatalf("repeat migration error = %v", err)
	}

	first, err := ImportCanvasProjects([]model.CanvasProject{{ID: "legacy-shared-id", OwnerUID: "legacy-owner", Title: "不应覆盖", Document: []byte(`{}`), Revision: 1}})
	if err != nil || len(first) != 1 || first[0].Title != "旧画布" {
		t.Fatalf("legacy owner import = %#v, %v", first, err)
	}
	second, err := ImportCanvasProjects([]model.CanvasProject{{ID: "legacy-shared-id", OwnerUID: "second-owner", Title: "第二个用户画布", Document: []byte(`{}`), Revision: 1}})
	if err != nil || len(second) != 1 || second[0].OwnerUID != "second-owner" {
		t.Fatalf("second owner import = %#v, %v", second, err)
	}
	firstProject, found, err := GetCanvasProject("legacy-owner", "legacy-shared-id")
	if err != nil || !found || firstProject.Title != "旧画布" {
		t.Fatalf("legacy project after migration = %#v, found=%t, err=%v", firstProject, found, err)
	}
}

func TestCanvasProjectDocumentUsesMySQLTextStorageAboveTheValidationLimit(t *testing.T) {
	database, err := gorm.Open(mysql.New(mysql.Config{
		DSN:                       "canvas:canvas@tcp(127.0.0.1:3306)/canvas",
		SkipInitializeWithVersion: true,
	}), &gorm.Config{DryRun: true, DisableAutomaticPing: true})
	if err != nil {
		t.Fatal(err)
	}
	statement := &gorm.Statement{DB: database}
	if err := statement.Parse(&model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	field := statement.Schema.LookUpField("Document")
	if field == nil {
		t.Fatal("CanvasProject.Document field was not found")
	}
	dataType := strings.ToLower(database.Migrator().FullDataTypeOf(field).SQL)
	if dataType != "mediumtext" && dataType != "longtext" {
		t.Fatalf("CanvasProject.Document MySQL type = %q, want MEDIUMTEXT or LONGTEXT", dataType)
	}
}

func TestMySQLCanvasProjectDocumentMigrationDecisionIsIdempotent(t *testing.T) {
	for _, test := range []struct {
		dataType string
		want     bool
	}{
		{dataType: "tinytext", want: true},
		{dataType: "text", want: true},
		{dataType: "varchar", want: true},
		{dataType: "mediumtext", want: false},
		{dataType: "longtext", want: false},
	} {
		t.Run(test.dataType, func(t *testing.T) {
			if got := mysqlCanvasProjectDocumentNeedsMigration(test.dataType); got != test.want {
				t.Fatalf("mysqlCanvasProjectDocumentNeedsMigration(%q) = %t, want %t", test.dataType, got, test.want)
			}
		})
	}
}
