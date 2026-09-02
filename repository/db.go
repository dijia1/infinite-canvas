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
		dbErr = db.AutoMigrate(
			&model.CanvasProject{},
			&model.Media{},
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
