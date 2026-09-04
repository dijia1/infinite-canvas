package repository

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var (
	db     *gorm.DB
	dbOnce sync.Once
	dbErr  error
)

// DB 初始化并返回全局数据库连接。
func DB() (*gorm.DB, error) {
	dbOnce.Do(func() {
		driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
		if driver == "" {
			driver = "sqlite"
		}
		dsn := config.Cfg.DatabaseDSN
		if driver == "sqlite" && dsn != ":memory:" {
			_ = os.MkdirAll(filepath.Dir(dsn), 0755)
		}
		db, dbErr = gorm.Open(dialector(driver, dsn), &gorm.Config{})
		if dbErr != nil {
			return
		}
		if dbErr = configureConnectionPool(db); dbErr != nil {
			return
		}
		if dbErr = migrateCanvasProjectPrimaryKey(db, driver); dbErr != nil {
			return
		}
		dbErr = db.AutoMigrate(
			&model.CanvasProject{},
			&model.CanvasSaveRequest{},
			&model.Media{},
			&model.MediaUploadIntent{},
			&model.ImageGenerationTask{},
			&model.PrivateFolder{},
			&model.PublicFolder{},
			&model.PublicImage{},
			&model.Setting{},
			&model.PortalMember{},
			&model.OperationLog{},
		)
	})
	return db, dbErr
}

// migrateCanvasProjectPrimaryKey upgrades the short-lived first canvas schema,
// whose primary key was only id, before any owner-scoped upserts are used.
// Fresh databases have no table yet and are created directly by AutoMigrate.
func migrateCanvasProjectPrimaryKey(database *gorm.DB, driver string) error {
	if !database.Migrator().HasTable("canvas_projects") {
		return nil
	}
	switch driver {
	case "postgres", "postgresql":
		return migratePostgresCanvasProjectPrimaryKey(database)
	case "mysql":
		return migrateMySQLCanvasProjectPrimaryKey(database)
	default:
		return migrateSQLiteCanvasProjectPrimaryKey(database)
	}
}

type sqliteTableInfo struct {
	Name string
	PK   int
}

func migrateSQLiteCanvasProjectPrimaryKey(database *gorm.DB) error {
	columns := make([]sqliteTableInfo, 0)
	if err := database.Raw("PRAGMA table_info(canvas_projects)").Scan(&columns).Error; err != nil {
		return err
	}
	if !hasLegacyCanvasProjectPrimaryKey(columns) {
		return nil
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		if err := transaction.Exec("ALTER TABLE canvas_projects RENAME TO canvas_projects_legacy_primary_key").Error; err != nil {
			return err
		}
		if err := transaction.Exec(`CREATE TABLE canvas_projects (
			id TEXT,
			owner_uid TEXT,
			title TEXT,
			document TEXT,
			revision INTEGER,
			created_at TEXT,
			updated_at TEXT,
			PRIMARY KEY (id, owner_uid)
		)`).Error; err != nil {
			return err
		}
		if err := transaction.Exec(`INSERT INTO canvas_projects (id, owner_uid, title, document, revision, created_at, updated_at)
			SELECT id, owner_uid, title, document, revision, created_at, updated_at FROM canvas_projects_legacy_primary_key`).Error; err != nil {
			return err
		}
		return transaction.Exec("DROP TABLE canvas_projects_legacy_primary_key").Error
	})
}

func hasLegacyCanvasProjectPrimaryKey(columns []sqliteTableInfo) bool {
	for _, column := range columns {
		if column.Name == "id" && column.PK == 1 {
			for _, other := range columns {
				if other.Name != "id" && other.PK != 0 {
					return false
				}
			}
			return true
		}
	}
	return false
}

func migratePostgresCanvasProjectPrimaryKey(database *gorm.DB) error {
	var columns string
	if err := database.Raw(`SELECT COALESCE(string_agg(attribute.attname, ',' ORDER BY array_position(index_definition.indkey, attribute.attnum)), '')
		FROM pg_index index_definition
		JOIN pg_attribute attribute ON attribute.attrelid = index_definition.indrelid AND attribute.attnum = ANY(index_definition.indkey)
		WHERE index_definition.indrelid = 'canvas_projects'::regclass AND index_definition.indisprimary`).Scan(&columns).Error; err != nil {
		return err
	}
	if columns != "id" {
		return nil
	}
	var constraint string
	if err := database.Raw(`SELECT conname FROM pg_constraint WHERE conrelid = 'canvas_projects'::regclass AND contype = 'p'`).Scan(&constraint).Error; err != nil {
		return err
	}
	if constraint == "" {
		return fmt.Errorf("canvas_projects legacy primary key constraint was not found")
	}
	return database.Transaction(func(transaction *gorm.DB) error {
		if err := transaction.Exec("ALTER TABLE canvas_projects DROP CONSTRAINT " + quotePostgresIdentifier(constraint)).Error; err != nil {
			return err
		}
		return transaction.Exec("ALTER TABLE canvas_projects ADD PRIMARY KEY (id, owner_uid)").Error
	})
}

func quotePostgresIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func migrateMySQLCanvasProjectPrimaryKey(database *gorm.DB) error {
	var columns string
	if err := database.Raw(`SELECT COALESCE(GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR ','), '')
		FROM information_schema.key_column_usage
		WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY'`, "canvas_projects").Scan(&columns).Error; err != nil {
		return err
	}
	if columns != "id" {
		return nil
	}
	return database.Exec("ALTER TABLE canvas_projects DROP PRIMARY KEY, ADD PRIMARY KEY (id, owner_uid)").Error
}

func configureConnectionPool(database *gorm.DB) error {
	sqlDB, err := database.DB()
	if err != nil {
		return err
	}

	maxOpenConns := config.Cfg.DatabaseMaxOpenConns
	if maxOpenConns == 0 {
		maxOpenConns = 20
	}
	if maxOpenConns < 1 {
		return fmt.Errorf("DB_MAX_OPEN_CONNS must be greater than 0")
	}

	maxIdleConns := config.Cfg.DatabaseMaxIdleConns
	if maxIdleConns == 0 {
		maxIdleConns = 10
	}
	if maxIdleConns < 0 || maxIdleConns > maxOpenConns {
		return fmt.Errorf("DB_MAX_IDLE_CONNS must be between 0 and DB_MAX_OPEN_CONNS")
	}

	maxLifetimeValue := strings.TrimSpace(config.Cfg.DatabaseConnMaxLifetime)
	if maxLifetimeValue == "" {
		maxLifetimeValue = "30m"
	}
	maxLifetime, err := time.ParseDuration(maxLifetimeValue)
	if err != nil {
		return fmt.Errorf("DB_CONN_MAX_LIFETIME must be a positive duration: %w", err)
	}
	if maxLifetime <= 0 {
		return fmt.Errorf("DB_CONN_MAX_LIFETIME must be a positive duration")
	}

	sqlDB.SetMaxOpenConns(maxOpenConns)
	sqlDB.SetMaxIdleConns(maxIdleConns)
	sqlDB.SetConnMaxLifetime(maxLifetime)
	return nil
}

func dialector(driver string, dsn string) gorm.Dialector {
	switch driver {
	case "mysql":
		return mysql.Open(dsn)
	case "postgres", "postgresql":
		return postgres.Open(dsn)
	default:
		return sqlite.Open(dsn)
	}
}
