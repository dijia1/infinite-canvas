package config

import (
	"os"
	"strings"
	"testing"
)

func TestLoadRejectsMissingDatabaseDSN(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(workingDirectory); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})

	previousValue, wasSet := os.LookupEnv("DATABASE_DSN")
	if err := os.Unsetenv("DATABASE_DSN"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if wasSet {
			if err := os.Setenv("DATABASE_DSN", previousValue); err != nil {
				t.Errorf("restore DATABASE_DSN: %v", err)
			}
			return
		}
		if err := os.Unsetenv("DATABASE_DSN"); err != nil {
			t.Errorf("unset DATABASE_DSN: %v", err)
		}
	})

	withEmptyConfig(t)
	err = Load()
	if err == nil {
		t.Fatal("Load() succeeded without DATABASE_DSN")
	}
	if !strings.Contains(err.Error(), "DATABASE_DSN") {
		t.Fatalf("Load() error = %q, want DATABASE_DSN validation error", err)
	}
}

func TestLoadRejectsEmptyDatabaseDSN(t *testing.T) {
	t.Setenv("DATABASE_DSN", "")
	withEmptyConfig(t)

	err := Load()
	if err == nil {
		t.Fatal("Load() succeeded with an empty DATABASE_DSN")
	}
	if !strings.Contains(err.Error(), "DATABASE_DSN") {
		t.Fatalf("Load() error = %q, want DATABASE_DSN validation error", err)
	}
}

func withEmptyConfig(t *testing.T) {
	t.Helper()
	previousConfig := Cfg
	Cfg = Config{}
	t.Cleanup(func() {
		Cfg = previousConfig
	})
}

func TestLoadRequiresTrustedPortalSigningConfiguration(t *testing.T) {
	previous := Cfg
	t.Cleanup(func() { Cfg = previous })
	t.Setenv("DATABASE_DSN", "postgres://test.invalid/test")
	for _, tt := range []struct {
		name, key, secret string
		valid             bool
	}{
		{"missing credential", "infinite-canvas", "", false},
		{"invalid app key", "../other", "test-secret", false},
		{"valid without UID bootstrap", "infinite-canvas", "test-secret", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("PORTAL_DIRECTORY_APP_KEY", tt.key)
			t.Setenv("PORTAL_DIRECTORY_SECRET", tt.secret)
			err := Load()
			if (err == nil) != tt.valid {
				t.Fatalf("Load error=%v", err)
			}
		})
	}
}
