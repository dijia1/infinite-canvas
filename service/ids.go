package service

import (
	"time"

	"github.com/google/uuid"
)

func newID(prefix string) string {
	return prefix + "-" + uuid.NewString()
}

func now() string {
	return time.Now().Format(time.RFC3339)
}
