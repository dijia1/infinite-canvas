package service

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// Model OSS version semantics: deleting a key without a version only creates
// a delete marker. It never removes the previous contents.
type ossCleanupFixture struct {
	mu          sync.Mutex
	versions    map[string]map[string]bool // true = delete marker
	failVersion string
	lists       int
	store       *ossImageStore
}

func newOSSCleanupFixture(t *testing.T) *ossCleanupFixture {
	t.Helper()
	f := &ossCleanupFixture{versions: map[string]map[string]bool{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		key := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/"), "test/")
		q := r.URL.Query()
		switch {
		case r.Method == "GET" && q.Has("versions"):
			f.lists++
			type entry struct {
				key, version string
				marker       bool
			}
			var entries []entry
			for key, versions := range f.versions {
				if strings.HasPrefix(key, q.Get("prefix")) {
					for version, marker := range versions {
						if key > q.Get("key-marker") || key == q.Get("key-marker") && version > q.Get("version-id-marker") {
							entries = append(entries, entry{key, version, marker})
						}
					}
				}
			}
			sort.Slice(entries, func(i, j int) bool {
				if entries[i].key == entries[j].key {
					return entries[i].version < entries[j].version
				}
				return entries[i].key < entries[j].key
			})
			more := len(entries) > 2
			if more {
				entries = entries[:2]
			}
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, "<ListVersionsResult><IsTruncated>%t</IsTruncated>", more)
			for _, entry := range entries {
				tag := "Version"
				if entry.marker {
					tag = "DeleteMarker"
				}
				fmt.Fprintf(w, "<%s><Key>%s</Key><VersionId>%s</VersionId></%s>", tag, entry.key, entry.version, tag)
			}
			if more {
				last := entries[len(entries)-1]
				fmt.Fprintf(w, "<NextKeyMarker>%s</NextKeyMarker><NextVersionIdMarker>%s</NextVersionIdMarker>", last.key, last.version)
			}
			fmt.Fprint(w, "</ListVersionsResult>")
		case r.Method == "DELETE":
			version := q.Get("versionId")
			if version != "" && version == f.failVersion {
				w.WriteHeader(503)
				fmt.Fprint(w, "<Error><Code>ServiceUnavailable</Code><Message>retry</Message></Error>")
				return
			}
			if version == "" {
				if f.versions[key] == nil {
					f.versions[key] = map[string]bool{}
				}
				f.versions[key]["new-marker"] = true
			} else {
				delete(f.versions[key], version)
			}
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected OSS call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(server.Close)
	client := oss.NewClient(oss.LoadDefaultConfig().WithRegion("test").WithEndpoint(server.URL).WithUseCName(true).WithRetryMaxAttempts(1).WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test")))
	f.store = &ossImageStore{internal: client, public: client, bucket: "test", ttl: time.Minute}
	return f
}
func TestOSSExactKeyCleanupRemovesVersionsAndMarkersOnly(t *testing.T) {
	f := newOSSCleanupFixture(t)
	key := "images/source.png"
	f.versions[key] = map[string]bool{"1": false, "2": false, "3": true, "4": false, "null": false}
	f.versions[key+".backup"] = map[string]bool{"1": false, "2": true, "3": false}
	for range 2 {
		if err := deleteImageObject(context.Background(), f.store, key); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.versions[key]) != 0 || len(f.versions[key+".backup"]) != 3 || f.lists < 3 {
		t.Fatalf("incorrect cleanup: %+v, lists=%d", f.versions, f.lists)
	}
}
func TestOSSPartialCleanupKeepsMediaUntilRetry(t *testing.T) {
	f := newOSSCleanupFixture(t)
	expiry := time.Now().Add(-time.Hour)
	item := saveTestPrivateMedia(t, newID("version-cleanup"), newID("owner"), &expiry)
	f.versions[item.ObjectKey] = map[string]bool{"1": false, "2": false, "3": true}
	f.failVersion = "2"
	current := time.Now()
	if err := cleanupExpiredCanvasMedia(context.Background(), current, func() (imageStore, error) { return f.store, nil }); err != nil {
		t.Fatal(err)
	}
	saved, found, err := repository.GetMedia(item.ID)
	if err != nil || !found || saved.CleanupStatus != model.MediaCleanupDeleting {
		t.Fatalf("lost retry record: %+v %t %v", saved, found, err)
	}
	f.failVersion = ""
	if err := cleanupExpiredCanvasMedia(context.Background(), current.Add(3*time.Minute), func() (imageStore, error) { return f.store, nil }); err != nil {
		t.Fatal(err)
	}
	if _, found, err := repository.GetMedia(item.ID); err != nil || found {
		t.Fatalf("retry not complete: %t %v", found, err)
	}
	if len(f.versions[item.ObjectKey]) != 0 {
		t.Fatal("versions remain")
	}
}

func TestUploadCleanupRechecksLateVersionsAndKeepsFailures(t *testing.T) {
	f := newOSSCleanupFixture(t)
	current := time.Now().UTC()
	intent := model.MediaUploadIntent{ID: newID("late-intent"), OwnerUID: newID("owner"), ObjectKey: newID("late-key"), Intent: "canvas", ExpiresAt: current.Add(-time.Minute).Format(time.RFC3339Nano), CreatedAt: current.Add(-time.Hour).Format(time.RFC3339Nano)}
	if err := repository.SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	if err := cleanupMediaUploadIntent(context.Background(), f.store, intent.ID, current); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := repository.GetMediaUploadIntentForOwner(intent.ID, intent.OwnerUID); !found {
		t.Fatal("first absence lost late-write tracking")
	}
	f.versions[intent.ObjectKey] = map[string]bool{"late": false, "marker": true}
	if err := cleanupMediaUploadIntent(context.Background(), f.store, intent.ID, current.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if len(f.versions[intent.ObjectKey]) != 0 {
		t.Fatal("late versions survived recheck")
	}
	f.versions[intent.ObjectKey] = map[string]bool{"failed": false}
	f.failVersion = "failed"
	if err := cleanupMediaUploadIntent(context.Background(), f.store, intent.ID, current.Add(25*time.Hour)); err == nil {
		t.Fatal("storage failure ignored")
	}
	if _, found, _ := repository.GetMediaUploadIntentForOwner(intent.ID, intent.OwnerUID); !found {
		t.Fatal("failed cleanup lost record")
	}
	f.failVersion = ""
	if err := cleanupMediaUploadIntent(context.Background(), f.store, intent.ID, current.Add(25*time.Hour+3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := repository.GetMediaUploadIntentForOwner(intent.ID, intent.OwnerUID); found {
		t.Fatal("final recheck did not remove intent")
	}
}

func TestMediaDeletionWaitsForSignedUploadExpiry(t *testing.T) {
	f := newOSSCleanupFixture(t)
	current := time.Now().UTC()
	item := saveTestPrivateMedia(t, newID("upload-delete"), newID("owner"), nil)
	intent := model.MediaUploadIntent{ID: newID("live-url"), OwnerUID: item.OwnerUID, ObjectKey: item.ObjectKey, Intent: "canvas", ExpiresAt: current.Add(time.Hour).Format(time.RFC3339Nano), CompletedMediaID: item.ID}
	if err := repository.SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	claimed, err := repository.PreparePrivateMediaDeletion(item.ID, item.OwnerUID, current)
	if err != nil {
		t.Fatal(err)
	}
	f.versions[item.ObjectKey] = map[string]bool{"original": false}
	if done, err := deleteClaimedMediaObject(context.Background(), f.store, claimed, current); err != nil || done {
		t.Fatalf("deleted with writable URL: %t %v", done, err)
	}
	f.versions[item.ObjectKey]["overwritten"] = false
	if done, err := deleteClaimedMediaObject(context.Background(), f.store, claimed, current.Add(time.Hour+time.Second)); err != nil || !done {
		t.Fatalf("expired URL deletion: %t %v", done, err)
	}
	if len(f.versions[item.ObjectKey]) != 0 {
		t.Fatal("overwritten version survived")
	}
	if _, err := repository.DeleteClaimedCanvasMedia(item.ID, claimed.CleanupClaimID); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := repository.GetMediaUploadIntentForOwner(intent.ID, item.OwnerUID); !found {
		t.Fatal("removed late-write tracking with media")
	}
}

func TestReservedObjectPublicationProtectsAmbiguousCommit(t *testing.T) {
	f := newOSSCleanupFixture(t)
	ctx := context.Background()
	owner := newID("owner")
	key := newID("reserved")
	if err := reserveMediaObject(ctx, owner, key); err != nil {
		t.Fatal(err)
	}
	item, err := repository.SaveMedia(model.Media{ID: newID("media"), OwnerUID: owner, ObjectKey: key})
	if err != nil {
		t.Fatal(err)
	}
	f.versions[key] = map[string]bool{"published": false}
	cleanupReservedMediaObject(ctx, f.store, key)
	if len(f.versions[key]) != 1 {
		t.Fatal("compensation deleted committed result")
	}
	t.Cleanup(func() { _ = repository.DeleteMedia(item.ID) })
}
