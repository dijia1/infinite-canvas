package config

import (
	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port                           string  `env:"PORT" envDefault:"8082"`
	StorageDriver                  string  `env:"STORAGE_DRIVER" envDefault:"sqlite"`
	DatabaseDSN                    string  `env:"DATABASE_DSN" envDefault:"data/infinite-canvas.db"`
	DatabaseMaxOpenConns           int     `env:"DB_MAX_OPEN_CONNS" envDefault:"20"`
	DatabaseMaxIdleConns           int     `env:"DB_MAX_IDLE_CONNS" envDefault:"10"`
	DatabaseConnMaxLifetime        string  `env:"DB_CONN_MAX_LIFETIME" envDefault:"30m"`
	PortalAdminRole                string  `env:"PORTAL_ADMIN_ROLE" envDefault:"portal-admin"`
	PortalDirectoryURL             string  `env:"PORTAL_DIRECTORY_URL" envDefault:"http://portal-api:3000/internal/directory/users"`
	PortalDirectoryAppKey          string  `env:"PORTAL_DIRECTORY_APP_KEY" envDefault:"infinite-canvas"`
	PortalDirectorySecret          string  `env:"PORTAL_DIRECTORY_SECRET"`
	MediaStorage                   string  `env:"MEDIA_STORAGE" envDefault:"local"`
	MediaLocalDir                  string  `env:"MEDIA_LOCAL_DIR" envDefault:"data/media"`
	OSSRegion                      string  `env:"OSS_REGION"`
	OSSBucket                      string  `env:"OSS_BUCKET"`
	OSSInternalEndpoint            string  `env:"OSS_INTERNAL_ENDPOINT"`
	OSSPublicEndpoint              string  `env:"OSS_PUBLIC_ENDPOINT"`
	OSSAccessKeyID                 string  `env:"OSS_ACCESS_KEY_ID"`
	OSSAccessKeySecret             string  `env:"OSS_ACCESS_KEY_SECRET"`
	OSSObjectPrefix                string  `env:"OSS_OBJECT_PREFIX" envDefault:"images"`
	OSSSignedURLTTL                string  `env:"OSS_SIGNED_URL_TTL" envDefault:"15m"`
	AITaskWorkerConcurrency        int     `env:"AI_TASK_WORKER_CONCURRENCY" envDefault:"4"`
	CanvasSaveSuccessLogSampleRate float64 `env:"CANVAS_SAVE_SUCCESS_LOG_SAMPLE_RATE" envDefault:"0.05"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	return nil
}
