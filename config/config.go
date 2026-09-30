package config

import (
	"errors"
	"regexp"
	"strings"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port                           string  `env:"PORT" envDefault:"8082"`
	DatabaseDSN                    string  `env:"DATABASE_DSN,required,notEmpty"`
	DatabaseMaxOpenConns           int     `env:"DB_MAX_OPEN_CONNS" envDefault:"20"`
	DatabaseMaxIdleConns           int     `env:"DB_MAX_IDLE_CONNS" envDefault:"10"`
	DatabaseConnMaxLifetime        string  `env:"DB_CONN_MAX_LIFETIME" envDefault:"30m"`
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
	AIVideoTaskTimeout             string  `env:"AI_VIDEO_TASK_TIMEOUT" envDefault:"30m"`
	AIImageTaskTimeout             string  `env:"AI_IMAGE_TASK_TIMEOUT" envDefault:"3m"`
	WorkflowEnabled                bool    `env:"WORKFLOW_ENABLED" envDefault:"true"`
	WorkflowGlobalConcurrency      int     `env:"WORKFLOW_GLOBAL_CONCURRENCY" envDefault:"4"`
	WorkflowRunConcurrency         int     `env:"WORKFLOW_RUN_CONCURRENCY" envDefault:"2"`
	CanvasSaveSuccessLogSampleRate float64 `env:"CANVAS_SAVE_SUCCESS_LOG_SAMPLE_RATE" envDefault:"0.05"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`).MatchString(Cfg.PortalDirectoryAppKey) {
		return errors.New("PORTAL_DIRECTORY_APP_KEY 无效")
	}
	if strings.TrimSpace(Cfg.PortalDirectorySecret) == "" {
		return errors.New("PORTAL_DIRECTORY_SECRET 必须配置本应用的服务凭据，用于 Portal 身份验签")
	}
	return nil
}
