package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const releaseRepo = "ghcr.io/dijia1/infinite-canvas:sha-"

type releaseFixture struct {
	t                     *testing.T
	root, app, state, bin string
}

func newReleaseFixture(t *testing.T) *releaseFixture {
	t.Helper()
	root := t.TempDir()
	f := &releaseFixture{t, root, filepath.Join(root, "app"), filepath.Join(root, "state"), filepath.Join(root, "bin")}
	for _, p := range []string{f.app, f.state, f.bin} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.write(filepath.Join(f.app, ".env"), "")
	for _, c := range []string{"a", "b", "c", "d", "e", "f"} {
		p := filepath.Join(f.app, "releases", strings.Repeat(c, 40))
		os.MkdirAll(p, 0700)
		f.write(filepath.Join(p, "docker-compose.yml"), "services: {}\n")
	}
	f.write(filepath.Join(root, "running"), releaseRepo+strings.Repeat("a", 40))
	f.write(filepath.Join(root, "lifecycle"), "running")
	f.write(filepath.Join(root, "images"), "")
	f.write(filepath.Join(root, "containers"), "app\n")
	f.write(filepath.Join(f.bin, "docker"), fakeReleaseDocker)
	f.write(filepath.Join(f.bin, "curl"), fakeGatewayCurl)
	// Only Docker/control-flow is simulated here; production flock is not replaced.
	f.write(filepath.Join(f.bin, "flock"), "#!/usr/bin/env bash\nexit 0\n")
	f.write(filepath.Join(f.bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n")
	f.legacy()
	return f
}
func (f *releaseFixture) write(p, s string) {
	f.t.Helper()
	if err := os.WriteFile(p, []byte(s), 0700); err != nil {
		f.t.Fatal(err)
	}
}
func (f *releaseFixture) read(p string) string {
	b, _ := os.ReadFile(filepath.Join(f.root, p))
	return string(b)
}
func (f *releaseFixture) legacy() {
	sha := strings.Repeat("a", 40)
	f.write(filepath.Join(f.state, "infinite-canvas-release.last-known-good"), "git_sha="+sha+"\nimage_ref="+releaseRepo+sha+"\nrelease_dir="+filepath.Join(f.app, "releases", sha)+"\n")
}
func (f *releaseFixture) run(script string, args ...string) (string, error) {
	cmd := exec.Command("bash", append([]string{"scripts/" + script}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+f.bin+":"+os.Getenv("PATH"), "MOCK_ROOT="+f.root, "INFINITE_CANVAS_APP_DIR="+f.app, "INFINITE_CANVAS_RELEASE_STATE_DIR="+f.state, "INFINITE_CANVAS_MEDIA_DIR="+filepath.Join(f.root, "media"))
	b, e := cmd.CombinedOutput()
	return string(b), e
}
func (f *releaseFixture) deploy(c string) (string, error) {
	sha := strings.Repeat(c, 40)
	return f.run("deploy-production.sh", sha, releaseRepo+sha, filepath.Join(f.app, "releases", sha))
}
func (f *releaseFixture) ok(c string) {
	f.t.Helper()
	if out, e := f.deploy(c); e != nil {
		f.t.Fatalf("deploy failed: %v\n%s", e, out)
	}
}
func TestReleaseBehavior(t *testing.T) {
	t.Run("success migrates legacy and keeps previous on same SHA", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.ok("b")
		state := f.read("state/infinite-canvas-release.last-known-good")
		if !strings.Contains(state, "current_sha="+strings.Repeat("b", 40)) || !strings.Contains(state, "previous_sha="+strings.Repeat("a", 40)) {
			t.Fatal(state)
		}
		f.ok("b")
		if got := f.read("state/infinite-canvas-release.last-known-good"); got != state {
			t.Fatal(got)
		}
		info, _ := os.Stat(filepath.Join(f.state, "infinite-canvas-release.last-known-good"))
		if info.Mode().Perm() != 0600 {
			t.Fatal(info.Mode())
		}
	})
	t.Run("health failure restores pre-deploy current and preserves state", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.ok("b")
		before := f.read("state/infinite-canvas-release.last-known-good")
		f.write(filepath.Join(f.root, "unhealthy"), releaseRepo+strings.Repeat("c", 40))
		if out, e := f.deploy("c"); e == nil {
			t.Fatal(out)
		}
		if f.read("running") != releaseRepo+strings.Repeat("b", 40) || f.read("state/infinite-canvas-release.last-known-good") != before {
			t.Fatal("rollback or state incorrect")
		}
	})
	t.Run("mismatched request SHA rejected before Docker", func(t *testing.T) {
		f := newReleaseFixture(t)
		a, b := strings.Repeat("a", 40), strings.Repeat("b", 40)
		if out, e := f.run("deploy-production.sh", b, releaseRepo+a, filepath.Join(f.app, "releases", b)); e == nil {
			t.Fatal(out)
		}
		if f.read("calls") != "" {
			t.Fatal(f.read("calls"))
		}
	})
	for _, failure := range []string{"running", "bad-id", "invalid-state"} {
		t.Run("preflight "+failure, func(t *testing.T) {
			f := newReleaseFixture(t)
			switch failure {
			case "running":
				f.write(filepath.Join(f.root, "running"), releaseRepo+strings.Repeat("c", 40))
			case "bad-id":
				f.write(filepath.Join(f.root, "bad-id"), "1")
			case "invalid-state":
				f.write(filepath.Join(f.state, "infinite-canvas-release.last-known-good"), "git_sha=bad\n")
			}
			if out, e := f.deploy("b"); e == nil {
				t.Fatal(out)
			}
			if strings.Contains(f.read("calls"), "pull ") {
				t.Fatal(f.read("calls"))
			}
		})
	}
	t.Run("cleanup failure does not rollback successful deployment", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.write(filepath.Join(f.root, "images"), releaseRepo+strings.Repeat("c", 40)+" id-c\n")
		f.write(filepath.Join(f.root, "rm-fail"), "1")
		out, e := f.deploy("b")
		if e != nil || !strings.Contains(out, "warning:") {
			t.Fatalf("%v %s", e, out)
		}
		if f.read("running") != releaseRepo+strings.Repeat("b", 40) {
			t.Fatal("unexpected rollback")
		}
	})
	t.Run("initialization verifies image and writes single baseline", func(t *testing.T) {
		f := newReleaseFixture(t)
		os.Remove(filepath.Join(f.state, "infinite-canvas-release.last-known-good"))
		a := strings.Repeat("a", 40)
		if out, e := f.run("initialize-release-state.sh", a, releaseRepo+a, filepath.Join(f.app, "releases", a)); e != nil {
			t.Fatalf("%v %s", e, out)
		}
		if !strings.Contains(f.read("state/infinite-canvas-release.last-known-good"), "previous_sha=\n") {
			t.Fatal("invented previous")
		}
	})
}
func TestReleaseFailureBoundaries(t *testing.T) {
	t.Run("state write failure rolls back without replacing record", func(t *testing.T) {
		f := newReleaseFixture(t)
		before := f.read("state/infinite-canvas-release.last-known-good")
		f.write(filepath.Join(f.bin, "mv"), "#!/usr/bin/env bash\nexit 1\n")
		if out, err := f.deploy("b"); err == nil {
			t.Fatal(out)
		}
		if f.read("running") != releaseRepo+strings.Repeat("a", 40) || f.read("state/infinite-canvas-release.last-known-good") != before {
			t.Fatal("failed atomic write changed baseline")
		}
		leftovers, _ := filepath.Glob(filepath.Join(f.state, ".infinite-canvas-release.*"))
		if len(leftovers) != 0 {
			t.Fatal(leftovers)
		}
	})
	t.Run("post deploy wrong image rolls back", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.write(filepath.Join(f.root, "wrong-up"), "1")
		if out, err := f.deploy("b"); err == nil {
			t.Fatal(out)
		}
		if f.read("running") != releaseRepo+strings.Repeat("a", 40) {
			t.Fatal("did not restore current")
		}
	})
	t.Run("missing protected image blocks cleanup", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.ok("b")
		f.write(filepath.Join(f.root, "inspect-fail"), "1")
		if out, err := f.run("cleanup-release-images.sh", "--apply"); err == nil {
			t.Fatal(out)
		}
		if f.read("removed") != "" {
			t.Fatal("removed with missing protected image")
		}
	})
}

func TestStoppedReleaseDeployment(t *testing.T) {
	for _, status := range []string{"exited", "created"} {
		t.Run(status+" release deploys without starting old image", func(t *testing.T) {
			f := newReleaseFixture(t)
			f.write(filepath.Join(f.root, "lifecycle"), status)
			f.ok("b")
			if f.read("lifecycle") != "running" || f.read("running") != releaseRepo+strings.Repeat("b", 40) {
				t.Fatal("new release did not start")
			}
			if !strings.Contains(f.read("state/infinite-canvas-release.last-known-good"), "current_sha="+strings.Repeat("b", 40)) {
				t.Fatal("healthy new release was not recorded")
			}
			if strings.Count(f.read("calls"), " up ") != 1 {
				t.Fatal("old release was started", f.read("calls"))
			}
		})
	}
	for _, failure := range []string{"health", "up", "state-write"} {
		t.Run(failure+" failure restores stopped baseline and permits retry", func(t *testing.T) {
			f := newReleaseFixture(t)
			f.write(filepath.Join(f.root, "lifecycle"), "exited")
			before := f.read("state/infinite-canvas-release.last-known-good")
			var faultFile string
			switch failure {
			case "health":
				faultFile = filepath.Join(f.root, "unhealthy")
				f.write(faultFile, releaseRepo+strings.Repeat("b", 40))
			case "up":
				faultFile = filepath.Join(f.root, "up-fail")
				f.write(faultFile, "1")
			case "state-write":
				faultFile = filepath.Join(f.bin, "mv")
				f.write(faultFile, "#!/usr/bin/env bash\nexit 1\n")
			}
			out, err := f.deploy("b")
			if err == nil {
				t.Fatal("failed target reported success", out)
			}
			if f.read("running") != releaseRepo+strings.Repeat("a", 40) || f.read("lifecycle") != "created" || f.read("state/infinite-canvas-release.last-known-good") != before {
				t.Fatal("stopped baseline not preserved", out, f.read("calls"))
			}
			calls := f.read("calls")
			if strings.Count(calls, " up ") != 1 || !strings.Contains(calls, " stop app") || !strings.Contains(calls, " create --no-build --force-recreate --pull never app") {
				t.Fatal("recovery must stop the target and recreate, not start, the baseline", calls)
			}
			if err := os.Remove(faultFile); err != nil {
				t.Fatal(err)
			}
			f.ok("b")
		})
	}
	for _, status := range []string{"unhealthy", "paused", "restarting", "dead", "missing", "multiple", "nonzero-exit", "oom", "wrong-image", "bad-id"} {
		t.Run("unsafe source "+status+" remains blocked", func(t *testing.T) {
			f := newReleaseFixture(t)
			switch status {
			case "unhealthy":
				f.write(filepath.Join(f.root, "unhealthy"), releaseRepo+strings.Repeat("a", 40))
			case "nonzero-exit":
				f.write(filepath.Join(f.root, "lifecycle"), "exited")
				f.write(filepath.Join(f.root, "exit-code"), "1")
			case "oom":
				f.write(filepath.Join(f.root, "lifecycle"), "exited")
				f.write(filepath.Join(f.root, "oom"), "true")
			case "wrong-image":
				f.write(filepath.Join(f.root, "lifecycle"), "exited")
				f.write(filepath.Join(f.root, "running"), releaseRepo+strings.Repeat("c", 40))
			case "bad-id":
				f.write(filepath.Join(f.root, "lifecycle"), "exited")
				f.write(filepath.Join(f.root, "bad-id"), "1")
			default:
				f.write(filepath.Join(f.root, "lifecycle"), status)
			}
			if out, err := f.deploy("b"); err == nil {
				t.Fatal("unsafe preflight passed", out)
			}
			calls := f.read("calls")
			if strings.Contains(calls, "pull ") || strings.Contains(calls, " up ") || strings.Contains(calls, " stop ") || strings.Contains(calls, " create ") {
				t.Fatal("preflight failure changed deployment", calls)
			}
		})
	}
	for _, failure := range []string{"stop-fail", "create-fail"} {
		t.Run("stopped recovery "+failure+" reports manual intervention", func(t *testing.T) {
			f := newReleaseFixture(t)
			f.write(filepath.Join(f.root, "lifecycle"), "exited")
			before := f.read("state/infinite-canvas-release.last-known-good")
			f.write(filepath.Join(f.root, "up-fail"), "1")
			f.write(filepath.Join(f.root, failure), "1")
			out, err := f.deploy("b")
			if err == nil || !strings.Contains(out, "manual intervention required") {
				t.Fatal("recovery failure was hidden", err, out)
			}
			if f.read("state/infinite-canvas-release.last-known-good") != before || strings.Count(f.read("calls"), " up ") != 1 {
				t.Fatal("recovery changed the baseline or started the old version", f.read("calls"))
			}
			if failure == "stop-fail" && strings.Contains(f.read("calls"), " create ") {
				t.Fatal("recreated a container after stop failed")
			}
			if failure == "create-fail" && f.read("lifecycle") != "exited" {
				t.Fatal("failed target was not left stopped")
			}
		})
	}
}

func TestReleaseImageCleanup(t *testing.T) {
	t.Run("protect versions aliases containers and other repositories", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.ok("b")
		f.write(filepath.Join(f.root, "containers"), "app\nstopped\n")
		f.write(filepath.Join(f.root, "images"), releaseRepo+strings.Repeat("a", 40)+" id-a\n"+releaseRepo+strings.Repeat("b", 40)+" id-b\n"+releaseRepo+strings.Repeat("c", 40)+" id-c\n"+releaseRepo+strings.Repeat("d", 40)+" id-d\n"+releaseRepo+strings.Repeat("e", 40)+" id-a\nother/repo:sha-old id-f\n")
		out, e := f.run("cleanup-release-images.sh")
		if e != nil || !strings.Contains(out, strings.Repeat("c", 40)) {
			t.Fatalf("%v %s", e, out)
		}
		if f.read("removed") != "" {
			t.Fatal("dry run removed an image")
		}
		if out, e := f.run("cleanup-release-images.sh", "--apply"); e != nil {
			t.Fatalf("%v %s", e, out)
		}
		if f.read("removed") != releaseRepo+strings.Repeat("c", 40)+"\n" {
			t.Fatal(f.read("removed"))
		}
	})
	t.Run("single baseline skips cleanup", func(t *testing.T) {
		f := newReleaseFixture(t)
		out, e := f.run("cleanup-release-images.sh", "--apply")
		if e != nil || !strings.Contains(out, "two distinct") {
			t.Fatalf("%v %s", e, out)
		}
		if f.read("calls") != "" {
			t.Fatal(f.read("calls"))
		}
	})
	t.Run("inventory failure deletes nothing", func(t *testing.T) {
		f := newReleaseFixture(t)
		f.ok("b")
		f.write(filepath.Join(f.root, "inventory-fail"), "1")
		if out, e := f.run("cleanup-release-images.sh", "--apply"); e == nil {
			t.Fatal(out)
		}
		if f.read("removed") != "" {
			t.Fatal("deleted with incomplete inventory")
		}
	})
}

const fakeReleaseDocker = `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_ROOT/calls"
image_id() { local s=${1##*:sha-}; printf 'id-%s\n' "${s:0:1}"; }
case "$1" in
 compose)
  while [[ $1 != config && $1 != up && $1 != ps && $1 != stop && $1 != create ]]; do shift; done
  case "$1" in
   config) exit 0 ;;
   up)
    if [[ -f "$MOCK_ROOT/wrong-up" && $INFINITE_CANVAS_IMAGE == *:sha-b* ]]; then echo incorrect > "$MOCK_ROOT/running"; else printf '%s' "$INFINITE_CANVAS_IMAGE" > "$MOCK_ROOT/running"; fi
    printf running > "$MOCK_ROOT/lifecycle"
    [[ ! -f "$MOCK_ROOT/up-fail" ]] || exit 1 ;;
   stop) [[ ! -f "$MOCK_ROOT/stop-fail" ]] || exit 1; printf exited > "$MOCK_ROOT/lifecycle" ;;
   create) [[ ! -f "$MOCK_ROOT/create-fail" ]] || exit 1; printf '%s' "$INFINITE_CANVAS_IMAGE" > "$MOCK_ROOT/running"; printf created > "$MOCK_ROOT/lifecycle" ;;
   ps)
    status=$(cat "$MOCK_ROOT/lifecycle")
    [[ $status != missing ]] || exit 0
    if [[ "$*" == *'--status running'* && $status != running ]]; then exit 0; fi
    echo app
    if [[ $status == multiple ]]; then echo second-app; fi ;;
  esac ;;
 pull) exit 0 ;;
 image)
  case "$2" in
   inspect) [[ ! -f "$MOCK_ROOT/inspect-fail" ]] || exit 1; image_id "${@: -1}" ;;
   ls) cat "$MOCK_ROOT/images" ;;
   rm) [[ ! -f "$MOCK_ROOT/rm-fail" ]] || exit 1; echo "$3" >> "$MOCK_ROOT/removed" ;;
   *) exit 90 ;;
  esac ;;
 ps) [[ ! -f "$MOCK_ROOT/inventory-fail" ]] || exit 1; cat "$MOCK_ROOT/containers" ;;
 inspect)
  container=${@: -1}
  case "$3" in
   '{{.Image}}') if [[ $container == stopped ]]; then echo id-d; elif [[ -f "$MOCK_ROOT/bad-id" ]]; then echo wrong-id; else image_id "$(cat "$MOCK_ROOT/running")"; fi ;;
   '{{.Config.Image}}') cat "$MOCK_ROOT/running" ;;
   '{{.State.Health.Status}}') if [[ -f "$MOCK_ROOT/unhealthy" && $(cat "$MOCK_ROOT/unhealthy") == "$(cat "$MOCK_ROOT/running")" ]]; then echo unhealthy; else echo healthy; fi ;;
   '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')
    printf '%s ' "$(cat "$MOCK_ROOT/lifecycle")"
    if [[ -f "$MOCK_ROOT/unhealthy" && $(cat "$MOCK_ROOT/unhealthy") == "$(cat "$MOCK_ROOT/running")" ]]; then echo unhealthy; else echo healthy; fi ;;
   '{{.State.Status}} {{.State.OOMKilled}} {{.State.ExitCode}}')
    status=$(cat "$MOCK_ROOT/lifecycle"); oom=false; code=0
    if [[ -f "$MOCK_ROOT/oom" ]]; then oom=$(cat "$MOCK_ROOT/oom"); fi
    if [[ -f "$MOCK_ROOT/exit-code" ]]; then code=$(cat "$MOCK_ROOT/exit-code"); fi
    printf '%s %s %s\n' "$status" "$oom" "$code" ;;
   *) exit 91 ;;
  esac ;;
 *) exit 92 ;;
esac
`

const fakeGatewayCurl = `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_ROOT/gateway-calls"
if [[ -f "$MOCK_ROOT/gateway-fault" && $(cat "$MOCK_ROOT/running") == *:sha-c* ]]; then
 case $(cat "$MOCK_ROOT/gateway-fault") in
  unavailable) printf '{"ok":false}\n503\napplication/json' ;;
  not-found) printf '{}\n404\napplication/json' ;;
  login) printf '<html>login</html>\n302\ntext/html' ;;
  spa) printf '<html>app</html>\n200\ntext/html' ;;
  bad-body) printf '{"ok":false}\n200\napplication/json' ;;
  wrong-type) printf '{"ok":true}\n200\ntext/plain' ;;
  malformed-key) printf '{"o k":true}\n200\napplication/json' ;;
  timeout) exit 28 ;;
 esac
else
 printf '{"ok":true}\n200\napplication/json'
fi
`

func TestGatewayFailureCannotPublishRelease(t *testing.T) {
	for _, fault := range []string{"unavailable", "not-found", "login", "spa", "bad-body", "wrong-type", "malformed-key", "timeout"} {
		t.Run(fault, func(t *testing.T) {
			f := newReleaseFixture(t)
			f.ok("b")
			before := f.read("state/infinite-canvas-release.last-known-good")
			f.write(filepath.Join(f.root, "gateway-fault"), fault)
			if out, err := f.deploy("c"); err == nil {
				t.Fatal("gateway failure published release", out)
			}
			if f.read("running") != releaseRepo+strings.Repeat("b", 40) || f.read("state/infinite-canvas-release.last-known-good") != before {
				t.Fatal("gateway failure did not preserve/restore healthy baseline")
			}
			calls := f.read("gateway-calls")
			if !strings.Contains(calls, "https://www.semetaloa.com/apps/infinite-canvas/api/healthz") || !strings.Contains(calls, "--disable --silent") || !strings.Contains(calls, "--max-time") || strings.Contains(calls, "--location") || strings.Contains(calls, "Authorization") || strings.Contains(calls, "Cookie") {
				t.Fatal(calls)
			}
		})
	}
}

func TestInitializationRequiresGatewayHealth(t *testing.T) {
	f := newReleaseFixture(t)
	os.Remove(filepath.Join(f.state, "infinite-canvas-release.last-known-good"))
	c := strings.Repeat("c", 40)
	f.write(filepath.Join(f.root, "running"), releaseRepo+c)
	f.write(filepath.Join(f.root, "gateway-fault"), "not-found")
	if out, err := f.run("initialize-release-state.sh", c, releaseRepo+c, filepath.Join(f.app, "releases", c)); err == nil {
		t.Fatal(out)
	}
	if f.read("state/infinite-canvas-release.last-known-good") != "" {
		t.Fatal("created baseline without gateway health")
	}
}
