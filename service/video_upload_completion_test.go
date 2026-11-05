package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestVideoUploadCompletionCopiesValidatedVersionWithoutReupload(t *testing.T) {
	for _, rejectCopy := range []bool{false, true} {
		t.Run(fmt.Sprintf("reject-copy-%v", rejectCopy), func(t *testing.T) {
			// The real ffprobe behavior has its own MP4 test. Stub only that
			// executable here so copy/publication regressions run without FFmpeg.
			bin := t.TempDir()
			probe := "#!/bin/sh\nprintf '%s' '{\"format\":{\"duration\":\"1\"},\"streams\":[{\"width\":160,\"height\":90}]}'\n"
			if err := os.WriteFile(filepath.Join(bin, "ffprobe"), []byte(probe), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			fixture := append([]byte{0, 0, 0, 24}, []byte("ftypmp42")...)
			fixture = append(fixture, make([]byte, 600)...)

			source := newID("video-source") + ".mp4"
			var mu sync.Mutex
			copies, uploads := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.Method == http.MethodPut {
					if r.Header.Get("x-oss-copy-source") == "" {
						uploads++
						http.Error(w, "unexpected upload", 400)
						return
					}
					copies++
					if !strings.Contains(r.Header.Get("x-oss-copy-source"), source+"?versionId=source-version") || r.Header.Get("x-oss-copy-source-if-match") != "source-etag" {
						t.Error("copy did not bind validated source version and ETag")
					}
					body, _ := io.ReadAll(r.Body)
					if len(body) != 0 {
						t.Error("copy uploaded video bytes")
					}
					if rejectCopy {
						w.WriteHeader(412)
						fmt.Fprint(w, "<Error><Code>PreconditionFailed</Code><Message>changed</Message></Error>")
						return
					}
					w.Header().Set("x-oss-version-id", "final-version")
					w.Header().Set("Content-Type", "application/xml")
					fmt.Fprint(w, `<CopyObjectResult><ETag>final-etag</ETag><LastModified>2026-11-01T00:00:00.000Z</LastModified></CopyObjectResult>`)
					return
				}
				isSource := strings.HasSuffix(r.URL.Path, source)
				version, etag := "final-version", "final-etag"
				if isSource {
					version, etag = "source-version", "source-etag"
				}
				if r.Method == http.MethodGet && r.URL.Query().Get("versionId") != version {
					t.Error("read did not bind source version")
				}
				if !isSource && r.Method == http.MethodHead && r.URL.Query().Get("versionId") != version {
					t.Error("final HEAD did not bind copy result version")
				}
				w.Header().Set("x-oss-version-id", version)
				w.Header().Set("ETag", etag)
				w.Header().Set("Content-Type", "video/mp4")
				data := fixture
				if r.Header.Get("Range") != "" && len(data) > 512 {
					data = data[:512]
				}
				w.Header().Set("Content-Length", fmt.Sprint(len(data)))
				if r.Method == http.MethodGet {
					w.Write(data)
				}
			}))
			defer server.Close()
			previous := config.Cfg
			t.Cleanup(func() { config.Cfg = previous })
			config.Cfg.MediaStorage = "oss"
			config.Cfg.OSSRegion = "cn-test"
			config.Cfg.OSSBucket = "test"
			config.Cfg.OSSInternalEndpoint = server.URL
			config.Cfg.OSSPublicEndpoint = server.URL
			config.Cfg.OSSAccessKeyID = "fake"
			config.Cfg.OSSAccessKeySecret = "fake"
			config.Cfg.OSSSignedURLTTL = "15m"
			user := PortalUser{UID: newID("video-owner")}
			intent := model.MediaUploadIntent{ID: newID("video-upload"), OwnerUID: user.UID, ObjectKey: source, Filename: "input.mp4", ContentType: "video/mp4", ExpectedBytes: int64(len(fixture)), Intent: "canvas", ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), CreatedAt: now()}
			if err := repository.SaveMediaUploadIntent(intent); err != nil {
				t.Fatal(err)
			}
			access, created, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID)
			if rejectCopy {
				if err == nil || created {
					t.Fatal("failed copy was published")
				}
				stored, _, _ := repository.GetMediaUploadIntentForOwner(intent.ID, user.UID)
				if stored.FinalObjectKey == "" || stored.CompletedMediaID != "" {
					t.Fatal("failed copy lost cleanup reservation or published media")
				}
			} else {
				if err != nil || !created {
					t.Fatalf("complete: %v", err)
				}
				item, found, err := repository.GetMedia(access.MediaID)
				if err != nil || !found || item.ObjectVersionID != "final-version" || item.ObjectETag != "final-etag" || access.Duration != 1 || access.Width != 160 {
					t.Fatalf("wrong bound video: %+v %v", item, err)
				}
				again, created, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID)
				if err != nil || created || again.MediaID != access.MediaID {
					t.Fatalf("completion replay: %+v %v", again, err)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if uploads != 0 || copies != 1 {
				t.Fatalf("copies=%d full uploads=%d", copies, uploads)
			}
		})
	}
}
