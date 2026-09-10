package main

import (
	"os"
	"strings"
	"testing"
)

func readDeploymentFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestProductionComposeUsesPortalNetworksAndHealthcheck(t *testing.T) {
	compose := readDeploymentFile(t, "docker-compose.yml")
	for _, expected := range []string{
		"image: ${INFINITE_CANVAS_IMAGE:?INFINITE_CANVAS_IMAGE is required}",
		"infinite-canvas-app",
		"infinite-canvas-directory",
		"portal_gateway:",
		"internal_tools_database:",
		"portal_directory:",
		"fetch('http://127.0.0.1:3000/api/healthz')",
		"\"node\", \"-e\"",
		"driver: json-file",
		"max-size: \"20m\"",
		"max-file: \"5\"",
	} {
		if !strings.Contains(compose, expected) {
			t.Fatalf("production compose missing %q", expected)
		}
	}
	if strings.Contains(compose, "build:") || strings.Contains(compose, "pull_policy:") || strings.Contains(compose, "ports:") || strings.Contains(compose, "\"bun\", \"-e\"") {
		t.Fatal("production compose must not build locally, override pull policy, or expose host ports")
	}
}

func TestLocalComposeJoinsPortalNetworks(t *testing.T) {
	compose := readDeploymentFile(t, "docker-compose.local.yml")
	for _, expected := range []string{
		"infinite-canvas-app",
		"infinite-canvas-directory",
		"portal_gateway:",
		"internal_tools_database:",
		"portal_directory:",
		"driver: json-file",
		"max-size: \"20m\"",
		"max-file: \"5\"",
	} {
		if !strings.Contains(compose, expected) {
			t.Fatalf("local compose missing %q", expected)
		}
	}
}

func TestReleaseWorkflowBuildsAndDeploysPrivateImageSecurely(t *testing.T) {
	workflow := readDeploymentFile(t, ".github/workflows/docker-image.yml")
	for _, expected := range []string{
		"go test ./...",
		"postgres:17-alpine",
		"TEST_DATABASE_DSN",
		"pg_isready",
		"bun test",
		"bun run typecheck",
		"bun run build",
		"platforms: linux/amd64",
		"type=raw,value=sha-${{ github.sha }}",
		"environment: production",
		"group: infinite-canvas-production",
		"cancel-in-progress: false",
		"if: github.ref == 'refs/heads/main'",
		"scripts/cleanup-release-images.sh",
		"scripts/release-state.sh",
		"bash -n",
		"docker compose config -q",
		"DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}",
		"DEPLOY_USER: ${{ secrets.DEPLOY_USER }}",
		"DEPLOY_SSH_PRIVATE_KEY: ${{ secrets.DEPLOY_SSH_PRIVATE_KEY }}",
		"DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}",
		"GHCR_READ_TOKEN: ${{ secrets.GHCR_READ_TOKEN }}",
		"StrictHostKeyChecking=yes",
		"IdentitiesOnly=yes",
		"UserKnownHostsFile=\"$known_hosts_file\"",
		"/program/apps/infinite-canvas/releases/$DEPLOY_SHA",
	} {
		if !strings.Contains(workflow, expected) {
			t.Fatalf("release workflow missing %q", expected)
		}
	}
	if strings.Contains(workflow, "ssh-keyscan") || strings.Contains(workflow, "git fetch") || strings.Contains(workflow, "git pull") {
		t.Fatal("release workflow must not weaken host verification or require server Git credentials")
	}
}

func TestDatabaseConfigurationIsPostgresOnly(t *testing.T) {
	example := readDeploymentFile(t, ".env.example")
	workflow := readDeploymentFile(t, ".github/workflows/docker-image.yml")
	combined := example + workflow

	storageDriver := strings.Join([]string{"STORAGE", "DRIVER"}, "_")
	localDatabaseFile := strings.Join([]string{"data", "infinite-canvas.db"}, "/")
	legacyDrivers := []string{
		"gorm.io/driver/" + "sqlite",
		"gorm.io/driver/" + "mysql",
	}
	for _, forbidden := range append([]string{storageDriver, localDatabaseFile}, legacyDrivers...) {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("database configuration contains legacy setting %q", forbidden)
		}
	}

	for _, required := range []string{
		"DATABASE_DSN=postgres://",
		"TEST_DATABASE_DSN",
		"postgres:17-alpine",
	} {
		if !strings.Contains(combined, required) {
			t.Fatalf("database configuration missing %q", required)
		}
	}
}

func TestReleaseScriptsProtectAndRestoreKnownGoodVersion(t *testing.T) {
	deploy := readDeploymentFile(t, "scripts/deploy-production.sh") + readDeploymentFile(t, "scripts/release-state.sh")
	initialize := readDeploymentFile(t, "scripts/initialize-release-state.sh")
	for _, expected := range []string{
		"set -Eeuo pipefail",
		"/program/data/infinite-canvas",
		"flock -n 9",
		"infinite-canvas-release.last-known-good",
	} {
		if !strings.Contains(deploy, expected) {
			t.Fatalf("deployment script missing %q", expected)
		}
	}
	for _, expected := range []string{"set -Eeuo pipefail", "source", "deploy-production.sh", "initialize_release_state \"$@\""} {
		if !strings.Contains(initialize, expected) {
			t.Fatalf("initialization script missing %q", expected)
		}
	}
	if strings.Contains(deploy, "git fetch") || strings.Contains(deploy, "git pull") {
		t.Fatal("deployment script must not require server Git credentials")
	}
}
