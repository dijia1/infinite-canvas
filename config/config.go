package config

import (
	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port                string `env:"PORT" envDefault:"8082"`
	StorageDriver       string `env:"STORAGE_DRIVER" envDefault:"sqlite"`
	DatabaseDSN         string `env:"DATABASE_DSN" envDefault:"data/infinite-canvas.db"`
	PortalAdminRole     string `env:"PORTAL_ADMIN_ROLE" envDefault:"portal-admin"`
	MediaStorage        string `env:"MEDIA_STORAGE" envDefault:"local"`
	MediaLocalDir       string `env:"MEDIA_LOCAL_DIR" envDefault:"data/media"`
	OSSRegion           string `env:"OSS_REGION"`
	OSSBucket           string `env:"OSS_BUCKET"`
	OSSInternalEndpoint string `env:"OSS_INTERNAL_ENDPOINT"`
	OSSPublicEndpoint   string `env:"OSS_PUBLIC_ENDPOINT"`
	OSSAccessKeyID      string `env:"OSS_ACCESS_KEY_ID"`
	OSSAccessKeySecret  string `env:"OSS_ACCESS_KEY_SECRET"`
	OSSObjectPrefix     string `env:"OSS_OBJECT_PREFIX" envDefault:"images"`
	OSSSignedURLTTL     string `env:"OSS_SIGNED_URL_TTL" envDefault:"15m"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	return nil
}
