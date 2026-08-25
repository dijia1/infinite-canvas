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
	} {
		if !strings.Contains(compose, expected) {
			t.Fatalf("production compose missing %q", expected)
		}
	}
	if strings.Contains(compose, "build:") || strings.Contains(compose, "pull_policy:") || strings.Contains(compose, "ports:") {
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
		"bun test",
		"bun run typecheck",
		"bun run build",
		"platforms: linux/amd64",
		"type=raw,value=sha-${{ github.sha }}",
		"environment: production",
		"group: infinite-canvas-production",
		"cancel-in-progress: false",
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

func TestReleaseScriptsProtectAndRestoreKnownGoodVersion(t *testing.T) {
	deploy := readDeploymentFile(t, "scripts/deploy-production.sh")
	initialize := readDeploymentFile(t, "scripts/initialize-release-state.sh")
	for _, expected := range []string{
		"set -Eeuo pipefail",
		"/program/data/infinite-canvas",
		"flock -n 9",
		"infinite-canvas-release.last-known-good",
		"docker compose",
		"rollback()",
		"wait_for_healthy",
		"docker pull",
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
