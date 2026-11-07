package service

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestVideoUploadCompletionAndShareCopyInsideOSSWithoutDownload(t *testing.T) {
	for _, test := range []struct {
		name       string
		intent     string
		rejectCopy bool
	}{
		{name: "canvas", intent: "canvas"},
		{name: "library", intent: "library"},
		{name: "default-library"},
		{name: "legacy-canvas", intent: "CANVAS"},
		{name: "canvas-copy-rejected", intent: "canvas", rejectCopy: true},
		{name: "library-copy-rejected", intent: "library", rejectCopy: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			rejectCopy := test.rejectCopy
			const bytes = 80 << 20 // Exceeds the old image/video limit without allocating a large fixture.
			source := newID("video-source") + ".mp4"
			var mu sync.Mutex
			copies, uploads, downloads := 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.Method == http.MethodGet {
					downloads++
					http.Error(w, "video downloads are forbidden", http.StatusBadRequest)
					return
				}
				if r.Method == http.MethodPut {
					if r.Header.Get("x-oss-copy-source") == "" {
						uploads++
						http.Error(w, "unexpected upload", 400)
						return
					}
					copies++
					version, etag := "final-version", "final-etag"
					if copies == 1 {
						version, etag = "source-version", "source-etag"
					}
					if !strings.Contains(r.Header.Get("x-oss-copy-source"), "?versionId="+version) || r.Header.Get("x-oss-copy-source-if-match") != etag {
						t.Error("copy did not bind source version and ETag")
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
				if !isSource && r.Method == http.MethodHead && r.URL.Query().Get("versionId") != version {
					t.Error("final HEAD did not bind copy result version")
				}
				w.Header().Set("x-oss-version-id", version)
				w.Header().Set("ETag", etag)
				w.Header().Set("Content-Type", "video/mp4")
				w.Header().Set("Content-Length", fmt.Sprint(bytes))
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
			intent := model.MediaUploadIntent{ID: newID("video-upload"), OwnerUID: user.UID, ObjectKey: source, Filename: "input.mp4", ContentType: "video/mp4", ExpectedBytes: bytes, Intent: test.intent, ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), CreatedAt: now()}
			if err := repository.SaveMediaUploadIntent(intent); err != nil {
				t.Fatal(err)
			}
			access, created, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID, MediaUploadCompletionInput{Duration: 16.25, Width: 720, Height: 1280})
			expectedCopies := 1
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
				if err != nil || !found || item.ObjectVersionID != "final-version" || item.ObjectETag != "final-etag" || access.Duration != 16.25 || access.Width != 720 || access.Height != 1280 || access.Bytes != bytes {
					t.Fatalf("wrong bound video: %+v %v", item, err)
				}
				temporary := strings.EqualFold(test.intent, "canvas")
				if temporary != (item.ExpiresAt != nil) || temporary != (access.MediaExpiresAt != nil) {
					t.Fatalf("intent %q: unexpected media expiry: stored=%v access=%v", test.intent, item.ExpiresAt, access.MediaExpiresAt)
				}
				if temporary && (item.ExpiresAt.Before(time.Now().Add(24*time.Hour-time.Minute)) || item.ExpiresAt.After(time.Now().Add(24*time.Hour))) {
					t.Fatalf("canvas upload expiry = %v, want 24 hours", item.ExpiresAt)
				}
				library, err := ListPrivateImages(context.Background(), user, "video")
				if err != nil || temporary && len(library.Items) != 0 || !temporary && (len(library.Items) != 1 || library.Items[0].ID != item.ID) {
					t.Fatalf("intent %q: private videos = %+v, error=%v", test.intent, library, err)
				}
				again, created, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID, MediaUploadCompletionInput{})
				if err != nil || created || again.MediaID != access.MediaID {
					t.Fatalf("completion replay: %+v %v", again, err)
				}
				store, err := newImageStore()
				if err != nil {
					t.Fatal(err)
				}
				shared, err := copyCanvasShareMedia(context.Background(), store, item, newID("video-recipient"))
				if err != nil || shared.Bytes != bytes || shared.Duration != item.Duration || shared.Width != item.Width || shared.Height != item.Height {
					t.Fatalf("large video share: %+v %v", shared, err)
				}
				expectedCopies++
			}
			mu.Lock()
			defer mu.Unlock()
			if uploads != 0 || downloads != 0 || copies != expectedCopies {
				t.Fatalf("copies=%d full uploads=%d downloads=%d", copies, uploads, downloads)
			}
		})
	}
}

func TestVideoUploadCompletionRejectsInvalidBrowserMetadata(t *testing.T) {
	user := PortalUser{UID: newID("video-owner")}
	intent := model.MediaUploadIntent{ID: newID("video-upload"), OwnerUID: user.UID, ObjectKey: "video.mp4", ContentType: "video/mp4", ExpectedBytes: 100, Intent: "canvas", ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), CreatedAt: now()}
	if err := repository.SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	for _, input := range []MediaUploadCompletionInput{
		{}, {Duration: -1, Width: 720, Height: 1280}, {Duration: math.NaN(), Width: 720, Height: 1280}, {Duration: math.Inf(1), Width: 720, Height: 1280}, {Duration: 5, Width: 0, Height: 1280}, {Duration: 5, Width: 720, Height: -1},
	} {
		if _, created, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID, input); err == nil || created || !strings.Contains(err.Error(), "时长或尺寸") {
			t.Fatalf("invalid metadata accepted: %+v, %v", input, err)
		}
	}
}

func TestImageUploadCompletionDoesNotReadFileContents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("image contents were requested: %s %s", r.Method, r.URL.Path)
			http.Error(w, "image downloads are forbidden", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Length", "1024")
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("x-oss-version-id", "image-version")
		w.Header().Set("ETag", "image-etag")
	}))
	defer server.Close()
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg.MediaStorage = "oss"
	config.Cfg.OSSRegion, config.Cfg.OSSBucket = "cn-test", "test"
	config.Cfg.OSSInternalEndpoint, config.Cfg.OSSPublicEndpoint = server.URL, server.URL
	config.Cfg.OSSAccessKeyID, config.Cfg.OSSAccessKeySecret = "fake", "fake"
	config.Cfg.OSSSignedURLTTL = "15m"
	user := PortalUser{UID: newID("image-owner")}
	intent := model.MediaUploadIntent{ID: newID("image-upload"), OwnerUID: user.UID, ObjectKey: newID("image-source") + ".png", Filename: "input.png", ContentType: "image/png", ExpectedBytes: 1024, Intent: "canvas", ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), CreatedAt: now()}
	if err := repository.SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	access, created, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID, MediaUploadCompletionInput{})
	if err != nil || !created || access.Bytes != 1024 || access.ContentType != "image/png" {
		t.Fatalf("image upload completion: %+v %v", access, err)
	}
}
