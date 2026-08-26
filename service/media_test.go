package service

import (
	"context"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/model"
)

type fakeImageStore struct {
	key     string
	deleted string
}

func (store *fakeImageStore) Put(_ context.Context, key string, _ []byte, _ string) error {
	store.key = key
	return nil
}
func (store *fakeImageStore) Get(_ context.Context, _ string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (store *fakeImageStore) Delete(_ context.Context, key string) error {
	store.deleted = key
	return nil
}
func (store *fakeImageStore) SignedURL(_ context.Context, key, process string) (string, time.Time, error) {
	url := "https://bucket.example/" + key + "?signed=1"
	if process != "" {
		url += "&x-oss-process=" + process
	}
	return url, time.Now().Add(time.Minute), nil
}

func TestPrivateLibraryImageObjectKeyIsScopedToPortalUser(t *testing.T) {
	key := privateImageObjectKey("7c001b0e-8a1b-4d65-a4b5-8ebd5c2d0011", model.MediaSourceUpload, "png", time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC))
	if want := "images/private/library/7c001b0e-8a1b-4d65-a4b5-8ebd5c2d0011/2026/08/"; len(key) <= len(want) || key[:len(want)] != want {
		t.Fatalf("privateImageObjectKey() = %q, want prefix %q", key, want)
	}
}

func TestGeneratedImageObjectKeyUsesGeneratedSourcePrefix(t *testing.T) {
	key := privateImageObjectKey("generator", model.MediaSourceGenerated, "webp", time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC))
	if want := "images/private/generated/generator/2026/08/"; len(key) <= len(want) || key[:len(want)] != want {
		t.Fatalf("privateImageObjectKey() = %q, want prefix %q", key, want)
	}
}

func TestPublicImageObjectKeyDoesNotUseUploaderDirectory(t *testing.T) {
	key := publicImageObjectKey("png", time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC))
	if want := "images/public/2026/08/"; len(key) <= len(want) || key[:len(want)] != want {
		t.Fatalf("publicImageObjectKey() = %q, want prefix %q", key, want)
	}
}

func TestMediaAccessAllowsOwnerAndPortalAdmin(t *testing.T) {
	item := model.Media{OwnerUID: "owner"}
	if !canAccessMedia(PortalUser{UID: "owner"}, item) {
		t.Fatal("owner should access media")
	}
	if !canAccessMedia(PortalUser{UID: "admin", Roles: []string{"portal-admin"}}, item) {
		t.Fatal("portal-admin should access media")
	}
	if canAccessMedia(PortalUser{UID: "other"}, item) {
		t.Fatal("other user must not access media")
	}
}

func TestPublicMediaAccessAllowsEveryPortalUser(t *testing.T) {
	item := model.Media{OwnerUID: "uploader"}
	if !canAccessPublicMedia(PortalUser{UID: "another-user"}, item) {
		t.Fatal("any authenticated Portal user should access public media")
	}
}

func TestSavePublicImageRejectsNamesOutsideTrimmedOneToSixtyFourCharacters(t *testing.T) {
	_, _, err := SavePublicImage(context.Background(), PortalUser{UID: "admin"}, "image.png", "image/png", nil, strings.Repeat("a", 65), "")
	if err == nil || !strings.Contains(err.Error(), "1-64") {
		t.Fatalf("SavePublicImage() error = %v, want title length validation", err)
	}
}

func TestMediaAccessIncludesWebPPreviewURL(t *testing.T) {
	access, err := mediaAccess(context.Background(), &fakeImageStore{}, model.Media{ID: "media-preview", ObjectKey: "images/private/user/source.png"})
	if err != nil {
		t.Fatalf("mediaAccess() error = %v", err)
	}
	preview := reflect.ValueOf(access).FieldByName("PreviewURL")
	if !preview.IsValid() || preview.String() == "" {
		t.Fatal("media access must include a preview URL")
	}
	if !strings.Contains(preview.String(), "x-oss-process="+mediaPreviewProcess) {
		t.Fatalf("PreviewURL = %q, want signed WebP process", preview.String())
	}
}

func TestMissingImageObjectErrorsAreSafeToDelete(t *testing.T) {
	if !isMissingImageObjectError(os.ErrNotExist) {
		t.Fatal("local missing object must be treated as already deleted")
	}
	if !isMissingImageObjectError(&oss.ServiceError{StatusCode: 404, Code: "NoSuchKey"}) {
		t.Fatal("OSS 404 object must be treated as already deleted")
	}
	if isMissingImageObjectError(&oss.ServiceError{StatusCode: 403, Code: "AccessDenied"}) {
		t.Fatal("OSS permission errors must not be treated as already deleted")
	}
}
