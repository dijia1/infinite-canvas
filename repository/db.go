package repository

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
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
		db, dbErr = gorm.Open(postgres.Open(config.Cfg.DatabaseDSN), &gorm.Config{})
		if dbErr != nil {
			return
		}
		if dbErr = configureConnectionPool(db); dbErr != nil {
			return
		}
		if dbErr = migratePostgresCanvasProjectPrimaryKey(db); dbErr != nil {
			return
		}
		dbErr = db.AutoMigrate(
			&model.CanvasProject{},
			&model.CanvasSaveRequest{},
			&model.Workflow{},
			&model.WorkflowMediaRef{},
			&model.WorkflowRun{},
			&model.WorkflowStepExecution{},
			&model.WorkflowOutputExecution{},
			&model.WorkflowOutputAttempt{},
			&model.Media{},
			&model.MediaUploadIntent{},
			&model.ImageGenerationTask{},
			&model.ImageGenerationTaskInput{},
			&model.VideoGenerationTask{},
			&model.PrivateFolder{},
			&model.PublicFolder{},
			&model.PublicImage{},
			&model.Setting{},
			&model.PortalMember{},
			&model.AppMemberRole{},
			&model.AppRBACState{},
			&model.OperationLog{},
		)
		if dbErr == nil {
			dbErr = migrateExplicitAspectRatios(db)
		}
		if dbErr == nil {
			dbErr = migrateWorkflowFrameSchema(db)
		}
	})
	return db, dbErr
}

// migratePostgresCanvasProjectPrimaryKey upgrades the short-lived first canvas
// schema, whose primary key was only id, before owner-scoped upserts are used.
// Fresh databases have no table yet and are created directly by AutoMigrate.
func migratePostgresCanvasProjectPrimaryKey(database *gorm.DB) error {
	if !database.Migrator().HasTable("canvas_projects") {
		return nil
	}
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
